import { createHash } from "node:crypto";
import { decodePaymentCredential } from "@ogp/canonical-codec";
import { hashSha256, verifyEd25519 } from "@ogp/crypto";
import {
  CLAIM_ACCOUNT_SIZE,
  decodeClaim,
  decodeOfflineSession,
  decodeStateEdgeRecord,
  type DecodedClaim,
} from "@ogp/protocol-sdk";
import { equalBytes, NetworkId } from "@ogp/shared-types";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountInfo,
  type Commitment,
} from "@solana/web3.js";

const CONFIG_SEED = Buffer.from("config");
const PROFILE_SEED = Buffer.from("user");
const SESSION_SEED = Buffer.from("session");
const CLAIM_SEED = Buffer.from("claim");
const EDGE_SEED = Buffer.from("edge");
const FORK_SEED = Buffer.from("fork");
const PAYMENT_PAYLOAD_SIZE = 410;
const SIGNATURE_SIZE = 64;
const ZERO = new PublicKey(new Uint8Array(32));

export interface ClaimRelayerRequest {
  readonly version: 1;
  readonly networkId: number;
  readonly clusterGenesisHash: string;
  readonly programId: string;
  readonly sessionAccount: string;
  readonly claimAccount: string;
  readonly merchant: string;
  readonly credentialPayload: string;
  readonly payerSignature: string;
  readonly credentialHash: string;
}

export interface ClaimRelayerConfig {
  readonly networkId: NetworkId;
  readonly clusterGenesisHash: Uint8Array;
  readonly programId: PublicKey;
  readonly relayer: Keypair;
  readonly connection: Pick<Connection,
    "getGenesisHash" | "getAccountInfo" | "getProgramAccounts" | "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction"
  >;
  readonly commitment?: Commitment;
}

export class RelayerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

export interface PlannedClaim {
  readonly request: ClaimRelayerRequest;
  readonly claim: PublicKey;
  readonly instruction: TransactionInstruction;
  readonly verifierInstruction: TransactionInstruction;
}

type ListedClaim = { readonly address: PublicKey; readonly value: DecodedClaim };

function exactHex(value: unknown, bytes: number, label: string): Uint8Array {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new RelayerError("INVALID_REQUEST", `${label} deve ser hexadecimal minúsculo com ${bytes} bytes`);
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function exactPublicKey(value: unknown, label: string): PublicKey {
  if (typeof value !== "string") throw new RelayerError("INVALID_REQUEST", `${label} ausente`);
  try {
    const key = new PublicKey(value);
    if (key.toBase58() !== value) throw new Error("non-canonical");
    return key;
  } catch {
    throw new RelayerError("INVALID_REQUEST", `${label} deve ser uma public key base58 canônica`);
  }
}

function strictRequest(value: unknown): ClaimRelayerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RelayerError("INVALID_REQUEST", "corpo deve ser um objeto JSON");
  }
  const record = value as Record<string, unknown>;
  const expected = ["claimAccount", "clusterGenesisHash", "credentialHash", "credentialPayload", "merchant", "networkId", "payerSignature", "programId", "sessionAccount", "version"];
  const observed = Object.keys(record).sort();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    throw new RelayerError("INVALID_REQUEST", "campos do request divergem do schema v1");
  }
  if (record.version !== 1 || !Number.isInteger(record.networkId)) {
    throw new RelayerError("INVALID_REQUEST", "version/networkId inválidos");
  }
  exactHex(record.clusterGenesisHash, 32, "clusterGenesisHash");
  exactHex(record.credentialPayload, PAYMENT_PAYLOAD_SIZE, "credentialPayload");
  exactHex(record.payerSignature, SIGNATURE_SIZE, "payerSignature");
  exactHex(record.credentialHash, 32, "credentialHash");
  exactPublicKey(record.programId, "programId");
  exactPublicKey(record.sessionAccount, "sessionAccount");
  exactPublicKey(record.claimAccount, "claimAccount");
  exactPublicKey(record.merchant, "merchant");
  return record as unknown as ClaimRelayerRequest;
}

function accountData(account: AccountInfo<Buffer> | null, owner: PublicKey, label: string): Uint8Array {
  if (account === null) throw new RelayerError("ACCOUNT_NOT_FOUND", `${label} não existe on-chain`, 409);
  if (!account.owner.equals(owner)) throw new RelayerError("WRONG_ACCOUNT_OWNER", `${label} pertence a outro programa`, 409);
  return new Uint8Array(account.data);
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function pda(program: PublicKey, seeds: readonly Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), program)[0];
}

function claimPda(program: PublicKey, session: PublicKey, hash: Uint8Array): PublicKey {
  return pda(program, [CLAIM_SEED, session.toBytes(), hash]);
}

function edgePda(program: PublicKey, session: PublicKey, previous: Uint8Array, sequence: number, next: Uint8Array): PublicKey {
  return pda(program, [EDGE_SEED, session.toBytes(), previous, u32(sequence), next]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertClaimList(sessionAddress: PublicKey, session: ReturnType<typeof decodeOfflineSession>, claims: readonly ListedClaim[]): void {
  if (BigInt(claims.length) !== session.submittedClaimCount) {
    throw new RelayerError("STALE_RPC_STATE", "contagem da lista de claims está inconsistente", 503);
  }
  if (claims.length === 0) {
    if (!new PublicKey(session.claimHead).equals(ZERO) || !new PublicKey(session.claimTail).equals(ZERO)) {
      throw new RelayerError("STALE_RPC_STATE", "sentinelas da lista vazia estão inconsistentes", 503);
    }
    return;
  }
  if (!claims[0]!.address.equals(new PublicKey(session.claimHead)) || !claims.at(-1)!.address.equals(new PublicKey(session.claimTail))) {
    throw new RelayerError("STALE_RPC_STATE", "cabeça/cauda da lista de claims estão inconsistentes", 503);
  }
  claims.forEach((entry, index) => {
    if (!equalBytes(entry.value.session, sessionAddress.toBytes())) throw new RelayerError("STALE_RPC_STATE", "claim de outra sessão entrou na lista", 503);
    const previous = index === 0 ? ZERO : claims[index - 1]!.address;
    const next = index === claims.length - 1 ? ZERO : claims[index + 1]!.address;
    if (!new PublicKey(entry.value.previousClaim).equals(previous) || !new PublicKey(entry.value.nextClaim).equals(next)) {
      throw new RelayerError("STALE_RPC_STATE", "links da lista de claims estão inconsistentes", 503);
    }
    if (index > 0 && compareBytes(claims[index - 1]!.value.credentialHash, entry.value.credentialHash) >= 0) {
      throw new RelayerError("STALE_RPC_STATE", "lista de claims não está estritamente ordenada", 503);
    }
  });
}

function submitClaimData(payload: Uint8Array, signature: Uint8Array): Buffer {
  const discriminator = createHash("sha256").update("global:submit_claim").digest().subarray(0, 8);
  return Buffer.concat([discriminator, u32(payload.length), Buffer.from(payload), Buffer.from(signature)]);
}

function verifierInstruction(): TransactionInstruction {
  const data = Buffer.alloc(16);
  data[0] = 1;
  data.writeUInt16LE(422, 2);
  data.writeUInt16LE(1, 4);
  data.writeUInt16LE(190, 6);
  data.writeUInt16LE(1, 8);
  data.writeUInt16LE(12, 10);
  data.writeUInt16LE(PAYMENT_PAYLOAD_SIZE, 12);
  data.writeUInt16LE(1, 14);
  return new TransactionInstruction({ programId: new PublicKey("Ed25519SigVerify111111111111111111111111111"), keys: [], data });
}

export class SolanaClaimRelayer {
  readonly #commitment: Commitment;
  readonly #inflight = new Map<string, Promise<{ readonly transactionSignature: string }>>();

  public constructor(private readonly config: ClaimRelayerConfig) {
    this.#commitment = config.commitment ?? "confirmed";
    if (config.clusterGenesisHash.length !== 32) throw new Error("clusterGenesisHash must contain 32 bytes");
  }

  public async plan(input: unknown): Promise<PlannedClaim> {
    const request = strictRequest(input);
    if (request.networkId !== this.config.networkId) throw new RelayerError("DOMAIN_MISMATCH", "networkId não autorizado", 403);
    const requestGenesis = exactHex(request.clusterGenesisHash, 32, "clusterGenesisHash");
    if (!equalBytes(requestGenesis, this.config.clusterGenesisHash)) throw new RelayerError("DOMAIN_MISMATCH", "genesis hash não autorizado", 403);
    const requestProgram = exactPublicKey(request.programId, "programId");
    if (!requestProgram.equals(this.config.programId)) throw new RelayerError("DOMAIN_MISMATCH", "program ID não autorizado", 403);
    let observedGenesis: Uint8Array;
    try {
      observedGenesis = new PublicKey(await this.config.connection.getGenesisHash()).toBytes();
    } catch {
      throw new RelayerError("RPC_UNAVAILABLE", "RPC não retornou genesis hash válido", 503);
    }
    if (!equalBytes(observedGenesis, this.config.clusterGenesisHash)) {
      throw new RelayerError("RPC_CLUSTER_MISMATCH", "RPC mudou para um cluster não autorizado", 503);
    }

    const payload = exactHex(request.credentialPayload, PAYMENT_PAYLOAD_SIZE, "credentialPayload");
    const signature = exactHex(request.payerSignature, SIGNATURE_SIZE, "payerSignature");
    const requestedHash = exactHex(request.credentialHash, 32, "credentialHash");
    const computedHash = hashSha256(Uint8Array.from([...payload, ...signature]));
    if (!equalBytes(requestedHash, computedHash)) throw new RelayerError("HASH_MISMATCH", "credentialHash não corresponde à evidência");
    let credential: ReturnType<typeof decodePaymentCredential>;
    try {
      credential = decodePaymentCredential(Uint8Array.from([...payload, ...signature]));
    } catch {
      throw new RelayerError("NON_CANONICAL_CREDENTIAL", "credentialPayload não é uma credencial canônica");
    }
    if (!verifyEd25519(signature, payload, credential.payerDeviceKey)) throw new RelayerError("INVALID_SIGNATURE", "assinatura do payer device inválida");
    if (credential.domain.networkId !== this.config.networkId
      || !equalBytes(credential.domain.clusterGenesisHash, this.config.clusterGenesisHash)
      || !equalBytes(credential.domain.programId, this.config.programId.toBytes())
      || !equalBytes(credential.domain.sessionId, credential.sessionId)) {
      throw new RelayerError("DOMAIN_MISMATCH", "domínio criptográfico da credencial não autorizado", 403);
    }

    const session = pda(this.config.programId, [SESSION_SEED, credential.payer, credential.sessionId]);
    const claim = claimPda(this.config.programId, session, computedHash);
    const merchant = new PublicKey(credential.merchant);
    if (!session.equals(exactPublicKey(request.sessionAccount, "sessionAccount"))
      || !claim.equals(exactPublicKey(request.claimAccount, "claimAccount"))
      || !merchant.equals(exactPublicKey(request.merchant, "merchant"))) {
      throw new RelayerError("DERIVATION_MISMATCH", "contas declaradas não correspondem à credencial");
    }
    if (await this.config.connection.getAccountInfo(claim, this.#commitment) !== null) {
      throw new RelayerError("CLAIM_ALREADY_EXISTS", "claim já existe on-chain", 409);
    }

    const sessionAccount = await this.config.connection.getAccountInfo(session, this.#commitment);
    const decodedSession = decodeOfflineSession(accountData(sessionAccount, this.config.programId, "OfflineSession"));
    if (!equalBytes(decodedSession.sessionId, credential.sessionId)
      || !equalBytes(decodedSession.owner, credential.payer)
      || !equalBytes(decodedSession.devicePublicKey, credential.payerDeviceKey)) {
      throw new RelayerError("SESSION_MISMATCH", "credencial diverge da sessão on-chain", 409);
    }

    const listed = await this.config.connection.getProgramAccounts(this.config.programId, {
      commitment: this.#commitment,
      filters: [{ dataSize: CLAIM_ACCOUNT_SIZE }, { memcmp: { offset: 40, bytes: session.toBase58() } }],
    });
    const claims = listed.map(({ pubkey, account }) => ({
      address: pubkey,
      value: decodeClaim(accountData(account, this.config.programId, "Claim")),
    })).sort((left, right) => compareBytes(left.value.credentialHash, right.value.credentialHash));
    assertClaimList(session, decodedSession, claims);

    const insertion = claims.findIndex((entry) => compareBytes(computedHash, entry.value.credentialHash) < 0);
    const predecessor = insertion === 0 ? session : (insertion < 0 ? claims.at(-1)?.address : claims[insertion - 1]?.address) ?? session;
    const successor = insertion < 0 ? session : claims[insertion]?.address ?? session;
    const edge = edgePda(this.config.programId, session, credential.previousStateHash, credential.sequence, credential.newStateHash);
    const edgeAccount = await this.config.connection.getAccountInfo(edge, this.#commitment);
    let representative = claim;
    let parent = session;
    if (edgeAccount !== null) {
      const decodedEdge = decodeStateEdgeRecord(accountData(edgeAccount, this.config.programId, "StateEdgeRecord"));
      representative = claimPda(this.config.programId, session, decodedEdge.representativeCredentialHash);
    } else if (credential.sequence > 1) {
      const parentClaim = claims.find((entry) => entry.value.sequence === credential.sequence - 1 && equalBytes(entry.value.newStateHash, credential.previousStateHash));
      if (parentClaim === undefined) throw new RelayerError("PARENT_NOT_FOUND", "aresta pai ainda não foi submetida", 409);
      parent = edgePda(this.config.programId, session, parentClaim.value.previousStateHash, parentClaim.value.sequence, parentClaim.value.newStateHash);
      accountData(await this.config.connection.getAccountInfo(parent, this.#commitment), this.config.programId, "parent StateEdgeRecord");
    }

    const profile = pda(this.config.programId, [PROFILE_SEED, credential.payer]);
    const config = pda(this.config.programId, [CONFIG_SEED]);
    const fork = pda(this.config.programId, [FORK_SEED, session.toBytes(), credential.previousStateHash, u32(credential.sequence)]);
    const instruction = new TransactionInstruction({
      programId: this.config.programId,
      keys: [
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: session, isSigner: false, isWritable: true },
        { pubkey: profile, isSigner: false, isWritable: true },
        { pubkey: merchant, isSigner: false, isWritable: false },
        { pubkey: this.config.relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: claim, isSigner: false, isWritable: true },
        { pubkey: edge, isSigner: false, isWritable: true },
        { pubkey: representative, isSigner: false, isWritable: true },
        { pubkey: predecessor, isSigner: false, isWritable: true },
        { pubkey: successor, isSigner: false, isWritable: true },
        { pubkey: fork, isSigner: false, isWritable: true },
        { pubkey: parent, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: submitClaimData(payload, signature),
    });
    return { request, claim, instruction, verifierInstruction: verifierInstruction() };
  }

  public submit(input: unknown): Promise<{ readonly transactionSignature: string }> {
    const request = strictRequest(input);
    const key = request.credentialHash;
    const existing = this.#inflight.get(key);
    if (existing !== undefined) return existing;
    const operation = this.#submit(request).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, operation);
    return operation;
  }

  async #submit(request: ClaimRelayerRequest): Promise<{ readonly transactionSignature: string }> {
    const plan = await this.plan(request);
    const latest = await this.config.connection.getLatestBlockhash(this.#commitment);
    const transaction = new Transaction({ feePayer: this.config.relayer.publicKey, ...latest })
      .add(plan.verifierInstruction, plan.instruction);
    transaction.sign(this.config.relayer);
    const transactionSignature = await this.config.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: this.#commitment,
      maxRetries: 3,
    });
    const confirmation = await this.config.connection.confirmTransaction({ signature: transactionSignature, ...latest }, this.#commitment);
    if (confirmation.value.err !== null) throw new RelayerError("TRANSACTION_FAILED", "transação falhou on-chain", 422);
    return { transactionSignature };
  }
}

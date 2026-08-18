import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { decodeClaim } from "@ogp/protocol-sdk";
import { equalBytes } from "@ogp/shared-types";
import type { StoredClaim } from "./claim-history";
import { materializeStoredClaimEvidence, type StoredClaimEvidence, type StoredClaimTrust } from "./claim-material";
import type { AuthoritativeClaimSnapshot, ClaimSubmissionPort } from "./claim-sync";

const SESSION_SEED = new TextEncoder().encode("session");
const CLAIM_SEED = new TextEncoder().encode("claim");
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;

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

export interface ClaimRelayer {
  readonly submit: (request: ClaimRelayerRequest) => Promise<{ readonly transactionSignature: string }>;
}

export interface SolanaClaimPortConfig {
  readonly rpcUrl?: string;
  readonly relayerUrl?: string;
  readonly programId: Uint8Array;
  readonly trust: StoredClaimTrust;
  readonly commitment?: Commitment;
  readonly requestTimeoutMs?: number;
  readonly confirmationTimeoutMs?: number;
  readonly confirmationPollMs?: number;
  readonly connection?: Pick<Connection, "getAccountInfoAndContext" | "getGenesisHash" | "getSignatureStatuses">;
  readonly relayer?: ClaimRelayer;
  readonly fetch?: typeof fetch;
}

export interface DerivedClaimAddresses {
  readonly session: PublicKey;
  readonly claim: PublicKey;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertProgramId(value: Uint8Array): PublicKey {
  if (value.length !== 32) throw new Error("program ID deve conter exatamente 32 bytes");
  return new PublicKey(value);
}

export function deriveClaimAddresses(programId: Uint8Array, evidence: StoredClaimEvidence): DerivedClaimAddresses {
  const program = assertProgramId(programId);
  const [session] = PublicKey.findProgramAddressSync([SESSION_SEED, evidence.owner, evidence.sessionId], program);
  const [claim] = PublicKey.findProgramAddressSync([CLAIM_SEED, session.toBytes(), evidence.material.credentialHash], program);
  return { session, claim };
}

function assertEndpoint(value: string, label: string, allowLocalHttp: boolean): URL {
  const endpoint = new URL(value);
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(allowLocalHttp && local && endpoint.protocol === "http:")) {
    throw new Error(`${label} deve usar HTTPS${allowLocalHttp ? " ou HTTP local" : ""}`);
  }
  if (endpoint.username !== "" || endpoint.password !== "") throw new Error(`${label} não pode conter credenciais`);
  return endpoint;
}

function createHttpRelayer(url: string, timeoutMs: number, fetchImpl: typeof fetch): ClaimRelayer {
  const base = assertEndpoint(url, "relayer URL", true);
  if (base.search !== "" || base.hash !== "") throw new Error("relayer URL não pode conter query ou fragmento");
  base.pathname = `${base.pathname.replace(/\/$/, "")}/v1/claims`;
  return {
    async submit(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`relayer recusou claim (HTTP ${response.status})`);
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null || !("transactionSignature" in body)) {
          throw new Error("resposta do relayer inválida");
        }
        const transactionSignature = (body as { transactionSignature?: unknown }).transactionSignature;
        if (typeof transactionSignature !== "string" || !SOLANA_SIGNATURE.test(transactionSignature)) {
          throw new Error("assinatura retornada pelo relayer é inválida");
        }
        return { transactionSignature };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function requestFor(
  program: PublicKey,
  addresses: DerivedClaimAddresses,
  evidence: StoredClaimEvidence,
  trust: StoredClaimTrust,
): ClaimRelayerRequest {
  return {
    version: 1,
    networkId: trust.networkId,
    clusterGenesisHash: bytesToHex(trust.clusterGenesisHash),
    programId: program.toBase58(),
    sessionAccount: addresses.session.toBase58(),
    claimAccount: addresses.claim.toBase58(),
    merchant: new PublicKey(evidence.merchant).toBase58(),
    credentialPayload: bytesToHex(evidence.material.payload),
    payerSignature: bytesToHex(evidence.material.payerSignature),
    credentialHash: bytesToHex(evidence.material.credentialHash),
  };
}

export function createSolanaClaimSubmissionPort(config: SolanaClaimPortConfig): ClaimSubmissionPort {
  const program = assertProgramId(config.programId);
  if (!equalBytes(config.programId, config.trust.programId)) throw new Error("program ID do RPC diverge do domínio criptográfico");
  const commitment = config.commitment ?? "confirmed";
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  const confirmationTimeoutMs = config.confirmationTimeoutMs ?? 45_000;
  const confirmationPollMs = config.confirmationPollMs ?? 750;
  if (requestTimeoutMs <= 0 || confirmationTimeoutMs <= 0 || confirmationPollMs <= 0) throw new Error("timeouts devem ser positivos");

  const connection = config.connection ?? (() => {
    if (config.rpcUrl === undefined) throw new Error("rpcUrl é obrigatório sem conexão injetada");
    assertEndpoint(config.rpcUrl, "RPC URL", true);
    return new Connection(config.rpcUrl, commitment);
  })();
  const relayer = config.relayer ?? (() => {
    if (config.relayerUrl === undefined) throw new Error("relayerUrl é obrigatório sem relayer injetado");
    return createHttpRelayer(config.relayerUrl, requestTimeoutMs, config.fetch ?? fetch);
  })();

  let clusterVerification: Promise<void> | undefined;
  const verifyCluster = (): Promise<void> => {
    clusterVerification ??= connection.getGenesisHash().then((value) => {
      let observed: Uint8Array;
      try {
        observed = new PublicKey(value).toBytes();
      } catch {
        throw new Error("genesis hash retornado pelo RPC é inválido");
      }
      if (!equalBytes(observed, config.trust.clusterGenesisHash)) throw new Error("RPC pertence a cluster inesperado");
    });
    return clusterVerification;
  };

  const evidenceFor = (claim: StoredClaim): { readonly evidence: StoredClaimEvidence; readonly addresses: DerivedClaimAddresses } => {
    const evidence = materializeStoredClaimEvidence(claim, config.trust);
    const addresses = deriveClaimAddresses(config.programId, evidence);
    return { evidence, addresses };
  };

  return {
    async lookupConfirmedClaim(claim) {
      await verifyCluster();
      const { evidence, addresses } = evidenceFor(claim);
      const result = await connection.getAccountInfoAndContext(addresses.claim, { commitment });
      if (result.value === null) return null;
      if (!result.value.owner.equals(program)) throw new Error("conta Claim pertence a program ID inesperado");

      const decoded = decodeClaim(new Uint8Array(result.value.data));
      if (!equalBytes(decoded.session, addresses.session.toBytes())) throw new Error("PDA de sessão do claim on-chain divergente");
      if (!equalBytes(decoded.credentialHash, evidence.material.credentialHash)) throw new Error("credential hash on-chain divergente");
      if (!equalBytes(decoded.merchant, evidence.merchant)) throw new Error("merchant on-chain divergente");
      if (decoded.amount !== evidence.amount) throw new Error("valor do claim on-chain divergente");

      return {
        confirmed: true,
        credentialHash: claim.credentialHash,
        sessionId: claim.sessionId,
        amount: claim.amount,
        status: decoded.status,
        confirmedSlot: result.context.slot.toString(),
        transactionSignature: null,
      } satisfies AuthoritativeClaimSnapshot;
    },

    async submitClaim(claim) {
      await verifyCluster();
      const { evidence, addresses } = evidenceFor(claim);
      const submitted = await relayer.submit(requestFor(program, addresses, evidence, config.trust));
      if (!SOLANA_SIGNATURE.test(submitted.transactionSignature)) throw new Error("assinatura retornada pelo relayer é inválida");
      return { transactionSignature: submitted.transactionSignature };
    },

    async confirmTransaction(transactionSignature) {
      await verifyCluster();
      if (!SOLANA_SIGNATURE.test(transactionSignature)) throw new Error("assinatura de transação inválida");
      const deadline = Date.now() + confirmationTimeoutMs;
      while (Date.now() <= deadline) {
        const result = await connection.getSignatureStatuses([transactionSignature], { searchTransactionHistory: true });
        const status = result.value[0];
        if (status?.err !== null && status?.err !== undefined) throw new Error("transação do claim falhou on-chain");
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
        await new Promise<void>((resolve) => setTimeout(resolve, confirmationPollMs));
      }
      throw new Error("tempo limite aguardando confirmação do claim");
    },
  };
}

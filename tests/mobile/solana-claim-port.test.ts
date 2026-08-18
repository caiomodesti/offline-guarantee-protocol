import { PublicKey } from "@solana/web3.js";
import { CLAIM_ACCOUNT_SIZE, CLAIM_DISCRIMINATOR } from "@ogp/protocol-sdk";
import { credentialHash } from "@ogp/credentials";
import { QRTransport } from "@ogp/transports";
import { describe, expect, it, vi } from "vitest";
import { createStoredClaim, type StoredClaim } from "../../apps/merchant-mobile/src/claim-history.js";
import { materializeStoredClaimEvidence, type StoredClaimTrust } from "../../apps/merchant-mobile/src/claim-material.js";
import {
  createSolanaClaimSubmissionPort,
  deriveClaimAddresses,
  type ClaimRelayerRequest,
  type SolanaClaimPortConfig,
} from "../../apps/merchant-mobile/src/solana-claim-port.js";
import { makeFixture } from "../crypto/fixture.js";

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

function storedFixture(): {
  readonly claim: StoredClaim;
  readonly trust: StoredClaimTrust;
  readonly fixture: ReturnType<typeof makeFixture>;
} {
  const fixture = makeFixture(50n);
  const frames = new QRTransport().sendCredential({
    sessionCertificate: fixture.certificate,
    deviceAuthorization: fixture.authorization,
    credentials: [fixture.credential],
  });
  return {
    fixture,
    trust: {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      trustedCertificateIssuer: fixture.context.trustedCertificateIssuer,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
    },
    claim: createStoredClaim({
      credentialHash: hex(credentialHash(fixture.credential)),
      sessionId: hex(fixture.credential.sessionId),
      amount: fixture.credential.amount.toString(),
      frames,
    }),
  };
}

function claimAccount(session: PublicKey, credential: ReturnType<typeof makeFixture>["credential"], status = 1): Uint8Array {
  const account = new Uint8Array(CLAIM_ACCOUNT_SIZE);
  account.set(CLAIM_DISCRIMINATOR, 0);
  account.set(credentialHash(credential), 8);
  account.set(session.toBytes(), 40);
  account.set(credential.merchant, 72);
  const view = new DataView(account.buffer);
  view.setBigUint64(104, credential.amount, true);
  view.setUint32(112, credential.sequence, true);
  account.set(credential.previousStateHash, 116);
  account.set(credential.newStateHash, 148);
  view.setBigUint64(180, 77n, true);
  view.setUint8(188, status);
  return account;
}

function config(
  source: ReturnType<typeof storedFixture>,
  overrides: Partial<SolanaClaimPortConfig> = {},
): SolanaClaimPortConfig {
  const { claim, trust, fixture } = source;
  const evidence = materializeStoredClaimEvidence(claim, trust);
  const addresses = deriveClaimAddresses(fixture.context.programId, evidence);
  const connection = {
    getGenesisHash: vi.fn(async () => new PublicKey(fixture.context.clusterGenesisHash).toBase58()),
    getAccountInfoAndContext: vi.fn(async () => ({
      context: { slot: 91 },
      value: {
        data: claimAccount(addresses.session, fixture.credential),
        executable: false,
        lamports: 1,
        owner: new PublicKey(fixture.context.programId),
        rentEpoch: 0,
      },
    })),
    getSignatureStatuses: vi.fn(async () => ({
      context: { slot: 92 },
      value: [{ confirmationStatus: "confirmed", confirmations: 1, err: null, slot: 92 }],
    })),
  } as unknown as NonNullable<SolanaClaimPortConfig["connection"]>;
  return {
    programId: fixture.context.programId,
    trust,
    connection,
    relayer: { submit: vi.fn(async () => ({ transactionSignature: "2".repeat(88) })) },
    confirmationPollMs: 1,
    ...overrides,
  };
}

describe("merchant Solana claim port", () => {
  it("derives deterministic PDAs and accepts only an owned, field-matching confirmed Claim", async () => {
    const source = storedFixture();
    const { claim } = source;
    const cfg = config(source);
    const port = createSolanaClaimSubmissionPort(cfg);

    const snapshot = await port.lookupConfirmedClaim(claim);

    expect(snapshot).toMatchObject({
      confirmed: true,
      credentialHash: claim.credentialHash,
      sessionId: claim.sessionId,
      amount: "50",
      status: "valid",
      confirmedSlot: "91",
      transactionSignature: null,
    });
    expect(cfg.connection?.getAccountInfoAndContext).toHaveBeenCalledOnce();
  });

  it("fails closed when the account owner is not the configured program", async () => {
    const source = storedFixture();
    const { claim } = source;
    const base = config(source);
    const connection = {
      ...base.connection,
      getAccountInfoAndContext: vi.fn(async () => ({
        context: { slot: 91 },
        value: {
          data: new Uint8Array(CLAIM_ACCOUNT_SIZE), executable: false, lamports: 1,
          owner: PublicKey.default, rentEpoch: 0,
        },
      })),
    } as unknown as NonNullable<SolanaClaimPortConfig["connection"]>;
    const port = createSolanaClaimSubmissionPort({ ...base, connection });

    await expect(port.lookupConfirmedClaim(claim)).rejects.toThrowError(/program ID inesperado/i);
  });

  it("sends the exact revalidated evidence to an untrusted relayer and ignores any status assertion", async () => {
    const source = storedFixture();
    const { claim, fixture } = source;
    let request: ClaimRelayerRequest | undefined;
    const relayer = {
      submit: vi.fn(async (value: ClaimRelayerRequest) => {
        request = value;
        return { transactionSignature: "3".repeat(88), status: "settled" };
      }),
    };
    const port = createSolanaClaimSubmissionPort(config(source, { relayer }));

    const result = await port.submitClaim(claim);

    expect(result).toEqual({ transactionSignature: "3".repeat(88) });
    expect(request).toMatchObject({
      version: 1,
      networkId: fixture.context.networkId,
      clusterGenesisHash: hex(fixture.context.clusterGenesisHash),
      credentialHash: claim.credentialHash,
    });
    expect(request?.credentialPayload).toHaveLength(820);
    expect(request?.payerSignature).toHaveLength(128);
    expect(request?.programId).toBe(new PublicKey(fixture.context.programId).toBase58());
  });

  it("waits for confirmed status and rejects a failed transaction", async () => {
    const source = storedFixture();
    const success = createSolanaClaimSubmissionPort(config(source));
    await expect(success.confirmTransaction("4".repeat(88))).resolves.toBeUndefined();

    const base = config(source);
    const connection = {
      ...base.connection,
      getSignatureStatuses: vi.fn(async () => ({ context: { slot: 93 }, value: [{ err: { InstructionError: [0, "Custom"] } }] })),
    } as unknown as NonNullable<SolanaClaimPortConfig["connection"]>;
    const failed = createSolanaClaimSubmissionPort({ ...base, connection });
    await expect(failed.confirmTransaction("5".repeat(88))).rejects.toThrowError(/falhou on-chain/i);
  });

  it("posts canonical JSON through the HTTPS relayer boundary", async () => {
    const source = storedFixture();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ transactionSignature: "6".repeat(88), status: "fabricated" }),
    })) as unknown as typeof fetch;
    const port = createSolanaClaimSubmissionPort(config(source, {
      relayer: undefined,
      relayerUrl: "https://relay.example/ogp",
      fetch: fetchMock,
    }));

    await expect(port.submitClaim(source.claim)).resolves.toEqual({ transactionSignature: "6".repeat(88) });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(url?.toString()).toBe("https://relay.example/ogp/v1/claims");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toMatchObject({ credentialHash: source.claim.credentialHash });
  });

  it("rejects a RPC endpoint from another cryptographic domain", async () => {
    const source = storedFixture();
    const base = config(source);
    const connection = {
      ...base.connection,
      getGenesisHash: vi.fn(async () => PublicKey.default.toBase58()),
    } as unknown as NonNullable<SolanaClaimPortConfig["connection"]>;
    const port = createSolanaClaimSubmissionPort({ ...base, connection });

    await expect(port.lookupConfirmedClaim(source.claim)).rejects.toThrowError(/cluster inesperado/i);
    expect(connection.getAccountInfoAndContext).not.toHaveBeenCalled();
  });
});

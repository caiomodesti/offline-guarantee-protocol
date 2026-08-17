import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createClaimSubmissionMaterial, OFFLINE_SESSION_ACCOUNT_SIZE, OFFLINE_SESSION_DISCRIMINATOR } from "@ogp/protocol-sdk";
import { NetworkId } from "@ogp/shared-types";
import { Keypair, PublicKey, Transaction, type AccountInfo } from "@solana/web3.js";
import { makeFixture } from "../crypto/fixture.js";
import { RelayerError, SolanaClaimRelayer, type ClaimRelayerRequest } from "../../apps/claim-relayer/src/claim-relayer.js";
import { createRelayerServer } from "../../apps/claim-relayer/src/server.js";

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function setup() {
  const fixture = makeFixture();
  const material = createClaimSubmissionMaterial(fixture.credential);
  const programId = new PublicKey(fixture.context.programId);
  const session = PublicKey.findProgramAddressSync([
    Buffer.from("session"), Buffer.from(fixture.credential.payer), Buffer.from(fixture.credential.sessionId),
  ], programId)[0];
  const claim = PublicKey.findProgramAddressSync([
    Buffer.from("claim"), session.toBuffer(), Buffer.from(material.credentialHash),
  ], programId)[0];
  const request: ClaimRelayerRequest = {
    version: 1,
    networkId: NetworkId.Devnet,
    clusterGenesisHash: hex(fixture.context.clusterGenesisHash),
    programId: programId.toBase58(),
    sessionAccount: session.toBase58(),
    claimAccount: claim.toBase58(),
    merchant: new PublicKey(fixture.credential.merchant).toBase58(),
    credentialPayload: hex(material.payload),
    payerSignature: hex(material.payerSignature),
    credentialHash: hex(material.credentialHash),
  };
  const sessionData = new Uint8Array(OFFLINE_SESSION_ACCOUNT_SIZE);
  sessionData.set(OFFLINE_SESSION_DISCRIMINATOR);
  sessionData.set(fixture.credential.sessionId, 8);
  sessionData.set(fixture.credential.payer, 40);
  sessionData.set(fixture.credential.payerDeviceKey, 72);
  new DataView(sessionData.buffer).setUint8(188, 0);
  const account = (data: Uint8Array): AccountInfo<Buffer> => ({ data: Buffer.from(data), executable: false, lamports: 1, owner: programId, rentEpoch: 0 });
  const relayer = Keypair.generate();
  const connection = {
    getGenesisHash: vi.fn(async () => new PublicKey(fixture.context.clusterGenesisHash).toBase58()),
    getAccountInfo: vi.fn(async (address: PublicKey) => address.equals(session) ? account(sessionData) : null),
    getProgramAccounts: vi.fn(async () => []),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 10 })),
    sendRawTransaction: vi.fn(async (serialized: Buffer | Uint8Array) => {
      const transaction = Transaction.from(Buffer.from(serialized));
      expect(transaction.instructions).toHaveLength(2);
      expect(transaction.instructions[0]?.programId.toBase58()).toBe("Ed25519SigVerify111111111111111111111111111");
      expect(transaction.instructions[1]?.keys[4]?.pubkey.equals(relayer.publicKey)).toBe(true);
      return "2".repeat(88);
    }),
    confirmTransaction: vi.fn(async () => ({ context: { slot: 1 }, value: { err: null } })),
  };
  const service = new SolanaClaimRelayer({
    networkId: NetworkId.Devnet,
    clusterGenesisHash: fixture.context.clusterGenesisHash,
    programId,
    relayer,
    connection,
  });
  return { request, service, connection };
}

describe("claim relayer", () => {
  it("builds, signs and confirms the exact two-instruction claim transaction", async () => {
    const { request, service, connection } = setup();
    await expect(service.submit(request)).resolves.toEqual({ transactionSignature: "2".repeat(88) });
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(connection.confirmTransaction).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent retries and relies on the claim PDA for durable idempotency", async () => {
    const { request, service, connection } = setup();
    await Promise.all([service.submit(request), service.submit(request)]);
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("rejects tampering before paying transaction fees", async () => {
    const { request, service, connection } = setup();
    await expect(service.submit({ ...request, credentialHash: "00".repeat(32) })).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await expect(service.submit({ ...request, networkId: NetworkId.MainnetBeta })).rejects.toMatchObject({ code: "DOMAIN_MISMATCH", httpStatus: 403 });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("returns a deterministic conflict when the claim PDA already exists", async () => {
    const { request, service, connection } = setup();
    connection.getAccountInfo.mockResolvedValueOnce({ data: Buffer.alloc(1), executable: false, lamports: 1, owner: new PublicKey(request.programId), rentEpoch: 0 });
    await expect(service.submit(request)).rejects.toEqual(expect.objectContaining<Partial<RelayerError>>({ code: "CLAIM_ALREADY_EXISTS", httpStatus: 409 }));
  });

  it("exposes only the bounded JSON endpoint and never serializes unknown errors", async () => {
    const submit = vi.fn(async () => ({ transactionSignature: "3".repeat(88) }));
    const server = createRelayerServer({ submit });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/claims`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ safe: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ transactionSignature: "3".repeat(88) });
      const wrongType = await fetch(`http://127.0.0.1:${port}/v1/claims`, { method: "POST", body: "{}" });
      expect(wrongType.status).toBe(415);
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

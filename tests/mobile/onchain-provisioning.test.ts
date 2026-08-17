import { describe, expect, it } from "vitest";
import { createPaymentCredential } from "@ogp/credentials";
import { QRTransport, type OfflineTrustEnvironment } from "@ogp/transports";
import { loadDevelopmentSession } from "../../apps/payer-mobile/src/dev-session.js";
import {
  createPersistedOnchainSession,
  hasCompleteOnchainStorage,
  restoreOnchainSession,
} from "../../apps/payer-mobile/src/onchain-provisioning.js";
import { hexToBytes } from "../../apps/payer-mobile/src/payer-runtime.js";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

function expectedEnvironment(): OfflineTrustEnvironment {
  const runtime = loadDevelopmentSession();
  return {
    networkId: runtime.trustContext.networkId,
    clusterGenesisHash: runtime.trustContext.clusterGenesisHash,
    programId: runtime.trustContext.programId,
    trustedCertificateIssuer: runtime.trustContext.trustedCertificateIssuer,
  };
}

describe("payer persisted on-chain provisioning", () => {
  it("round-trips a confirmed signed session without inventing local capacity", () => {
    const runtime = loadDevelopmentSession();
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime });
    const restored = restoreOnchainSession(persisted.provisioningJson, persisted.branchStateJson, persisted.deviceSecretHex, expectedEnvironment());

    expect(restored.parent).toEqual(runtime.initialParent);
    expect(restored.credentials).toEqual([]);
    expect(restored.localProvisioning).toMatchObject({
      source: "on-chain",
      provisioningConfirmed: true,
      sessionAccount: "44".repeat(32),
      branchStatePresent: true,
    });
    expect(restored.confirmedSessionSlot).toBe(runtime.sessionCertificate.finalizedSlot.toString());
  });

  it("restores the verified final branch and pending delivery", () => {
    const runtime = loadDevelopmentSession();
    const credential = createPaymentCredential(
      runtime.trustContext,
      runtime.sessionCertificate,
      runtime.initialParent,
      {
        merchant: bytes(0x71),
        merchantDeviceKey: bytes(0x72),
        amount: 50n,
        merchantChallenge: bytes(0x73),
        createdAt: runtime.sessionCertificate.issuedAt + 1n,
      },
      hexToBytes(runtime.deviceSecretHex),
    );
    const frames = new QRTransport().sendCredential({
      sessionCertificate: runtime.sessionCertificate,
      deviceAuthorization: runtime.deviceAuthorization,
      credentials: [credential],
    });
    const parent = { stateHash: credential.newStateHash, sequence: credential.sequence, remaining: credential.newRemaining };
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime, parent, frames, pendingDelivery: true });
    const restored = restoreOnchainSession(persisted.provisioningJson, persisted.branchStateJson, persisted.deviceSecretHex, expectedEnvironment());

    expect(restored.parent).toEqual(parent);
    expect(restored.credentials).toHaveLength(1);
    expect(restored.pendingDelivery).toBe(true);
    expect(restored.outgoingFrames).toEqual(frames);
  });

  it("rejects partial storage, a lost device key, a false trust root, and local rollback metadata", () => {
    const runtime = loadDevelopmentSession();
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime });
    expect(hasCompleteOnchainStorage(persisted.provisioningJson, null, persisted.deviceSecretHex)).toBe(false);
    expect(() => restoreOnchainSession(persisted.provisioningJson, persisted.branchStateJson, "03".repeat(32), expectedEnvironment()))
      .toThrow(/chave protegida/);
    expect(() => restoreOnchainSession(persisted.provisioningJson, persisted.branchStateJson, persisted.deviceSecretHex, {
      ...expectedEnvironment(),
      trustedCertificateIssuer: bytes(0x99),
    })).toThrow(/issuer|trust root/i);

    const branch = JSON.parse(persisted.branchStateJson) as Record<string, unknown>;
    branch.remaining = "999999";
    expect(() => restoreOnchainSession(persisted.provisioningJson, JSON.stringify(branch), persisted.deviceSecretHex, expectedEnvironment()))
      .toThrow(/cadeia criptográfica/);
  });

  it("rejects unsigned confirmation metadata and pending delivery without proof frames", () => {
    const runtime = loadDevelopmentSession();
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime });
    const provisioning = JSON.parse(persisted.provisioningJson) as Record<string, unknown>;
    provisioning.confirmedSessionSlot = "999";
    expect(() => restoreOnchainSession(JSON.stringify(provisioning), persisted.branchStateJson, persisted.deviceSecretHex, expectedEnvironment()))
      .toThrow(/slot confirmado/);

    expect(() => createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime, pendingDelivery: true }))
      .toThrow(/entrega pendente exige prova/);
  });
});

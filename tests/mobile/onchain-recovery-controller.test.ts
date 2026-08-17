import { describe, expect, it, vi } from "vitest";
import type { OfflineTrustEnvironment } from "@ogp/transports";
import { loadDevelopmentSession } from "../../apps/payer-mobile/src/dev-session.js";
import { createPersistedOnchainSession } from "../../apps/payer-mobile/src/onchain-provisioning.js";
import {
  evaluatePayerRecovery,
  persistConfirmedProvisioning,
  type PayerRecoveryChainPort,
  type PayerRecoveryStoragePort,
  type PayerRecoveryStorageSnapshot,
} from "../../apps/payer-mobile/src/onchain-recovery-controller.js";
import { bytesToHex } from "../../apps/payer-mobile/src/payer-runtime.js";
import type { AuthoritativeRecoveryState } from "../../apps/payer-mobile/src/session-access.js";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const hex = (value: number): string => value.toString(16).padStart(2, "0").repeat(32);

function expectedEnvironment(): OfflineTrustEnvironment {
  const runtime = loadDevelopmentSession();
  return {
    networkId: runtime.trustContext.networkId,
    clusterGenesisHash: runtime.trustContext.clusterGenesisHash,
    programId: runtime.trustContext.programId,
    trustedCertificateIssuer: runtime.trustContext.trustedCertificateIssuer,
  };
}

function storage(snapshot: PayerRecoveryStorageSnapshot): PayerRecoveryStoragePort {
  return {
    load: vi.fn(async () => snapshot),
    writeBranchState: vi.fn(async () => undefined),
    writeProvisioning: vi.fn(async () => undefined),
    writeProtectedDeviceSecret: vi.fn(async () => undefined),
  };
}

function authority(active: boolean): AuthoritativeRecoveryState {
  const runtime = loadDevelopmentSession();
  return {
    confirmed: true,
    profileOwner: hex(0xc3),
    offlineAccessEnabled: true,
    activeSessionAccount: active ? hex(0x44) : null,
    sessionAccount: active ? hex(0x44) : null,
    sessionId: active ? Array.from(runtime.sessionCertificate.sessionId, (value) => value.toString(16).padStart(2, "0")).join("") : null,
    sessionOwner: active ? hex(0xc3) : null,
    sessionDevicePublicKey: active ? bytesToHex(runtime.sessionCertificate.devicePublicKey) : null,
    sessionStatus: active ? "active" : null,
  };
}

function chain(value: AuthoritativeRecoveryState): PayerRecoveryChainPort {
  return { fetchConfirmedRecovery: vi.fn(async () => value) };
}

describe("payer on-chain recovery controller", () => {
  it("boots a complete signed local session offline without consulting RPC", async () => {
    const runtime = loadDevelopmentSession();
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime });
    const rpc = chain(authority(true));
    const result = await evaluatePayerRecovery({ connected: false, walletOwnerHex: null, expectedEnvironment: expectedEnvironment() }, storage({
      provisioningJson: persisted.provisioningJson,
      branchStateJson: persisted.branchStateJson,
      deviceSecretHex: persisted.deviceSecretHex,
    }), rpc);

    expect(result.decision.outcome).toBe("offline-ready");
    expect(result.restoredSession).not.toBeNull();
    expect(rpc.fetchConfirmedRecovery).not.toHaveBeenCalled();
  });

  it("requires explicit wallet authorization before checking an empty online installation", async () => {
    const rpc = chain(authority(false));
    const result = await evaluatePayerRecovery({ connected: true, walletOwnerHex: null, expectedEnvironment: expectedEnvironment() }, storage({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null }), rpc);
    expect(result.decision.outcome).toBe("wallet-authorization-required");
    expect(rpc.fetchConfirmedRecovery).not.toHaveBeenCalled();
  });

  it("allows provisioning only when the confirmed profile is free and the wallet owner is explicit", async () => {
    const rpc = chain(authority(false));
    const result = await evaluatePayerRecovery({ connected: true, walletOwnerHex: hex(0xc3), expectedEnvironment: expectedEnvironment() }, storage({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null }), rpc);
    expect(result.decision.outcome).toBe("new-session-allowed");
    expect(rpc.fetchConfirmedRecovery).toHaveBeenCalledWith(hex(0xc3));
  });

  it("blocks reprovisioning when Solana still has an active session after local loss", async () => {
    const result = await evaluatePayerRecovery({ connected: true, walletOwnerHex: hex(0xc3), expectedEnvironment: expectedEnvironment() }, storage({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null }), chain(authority(true)));
    expect(result.decision).toEqual({ outcome: "active-session-blocks-reprovisioning", reason: "active-session-local-binding-missing" });
  });

  it("rejects wallet substitution before making a chain request", async () => {
    const runtime = loadDevelopmentSession();
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime });
    const rpc = chain(authority(true));
    const result = await evaluatePayerRecovery({ connected: true, walletOwnerHex: hex(0x99), expectedEnvironment: expectedEnvironment() }, storage({
      provisioningJson: persisted.provisioningJson,
      branchStateJson: persisted.branchStateJson,
      deviceSecretHex: persisted.deviceSecretHex,
    }), rpc);
    expect(result.decision.reason).toBe("active-session-local-binding-mismatch");
    expect(rpc.fetchConfirmedRecovery).not.toHaveBeenCalled();
  });

  it("writes the protected key last and leaves any interrupted commit fail-closed", async () => {
    const runtime = loadDevelopmentSession();
    const persisted = createPersistedOnchainSession({ sessionAccount: bytes(0x44), runtime });
    const order: string[] = [];
    const port: PayerRecoveryStoragePort = {
      load: vi.fn(async () => ({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null })),
      writeBranchState: vi.fn(async () => { order.push("branch"); }),
      writeProvisioning: vi.fn(async () => { order.push("provisioning"); }),
      writeProtectedDeviceSecret: vi.fn(async () => { order.push("secret"); }),
    };
    await persistConfirmedProvisioning(port, persisted);
    expect(order).toEqual(["branch", "provisioning", "secret"]);
  });
});

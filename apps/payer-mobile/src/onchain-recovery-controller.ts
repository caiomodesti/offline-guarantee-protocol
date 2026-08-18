import type { OfflineTrustEnvironment } from "@ogp/transports";
import { hasCompleteOnchainStorage, restoreOnchainSession, type PersistedOnchainSession, type RestoredOnchainSession } from "./onchain-provisioning.js";
import { decideSessionAccess, type AuthoritativeRecoveryState, type SessionAccessDecision } from "./session-access.js";

const HEX_32 = /^[0-9a-f]{64}$/;

export interface PayerRecoveryStorageSnapshot {
  readonly provisioningJson: string | null;
  readonly branchStateJson: string | null;
  readonly deviceSecretHex: string | null;
}

export interface PayerRecoveryStoragePort {
  readonly load: () => Promise<PayerRecoveryStorageSnapshot>;
  readonly writeBranchState: (value: string) => Promise<void>;
  readonly writeProvisioning: (value: string) => Promise<void>;
  readonly writeProtectedDeviceSecret: (value: string) => Promise<void>;
}

export interface PayerRecoveryChainPort {
  /** Must return account data observed at confirmed commitment and validated against the expected program. */
  readonly fetchConfirmedRecovery: (ownerHex: string) => Promise<AuthoritativeRecoveryState>;
}

export interface PayerRecoveryControllerInput {
  readonly connected: boolean;
  readonly walletOwnerHex: string | null;
  readonly expectedEnvironment: OfflineTrustEnvironment;
}

export interface PayerRecoveryControllerResult {
  readonly decision: SessionAccessDecision;
  readonly restoredSession: RestoredOnchainSession | null;
  readonly localValidationError: string | null;
  readonly authoritative: AuthoritativeRecoveryState | null;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "material local inválido";
}

function walletOwner(value: string | null): string | null {
  if (value === null) return null;
  if (!HEX_32.test(value)) throw new Error("wallet owner deve conter exatamente 32 bytes hexadecimais");
  return value;
}

async function restoreLocal(storage: PayerRecoveryStoragePort, expected: OfflineTrustEnvironment): Promise<{
  readonly restored: RestoredOnchainSession | null;
  readonly error: string | null;
}> {
  const snapshot = await storage.load();
  const present = [snapshot.provisioningJson, snapshot.branchStateJson, snapshot.deviceSecretHex].filter((value) => value !== null).length;
  if (present === 0) return { restored: null, error: null };
  if (!hasCompleteOnchainStorage(snapshot.provisioningJson, snapshot.branchStateJson, snapshot.deviceSecretHex)) {
    return { restored: null, error: "A instalação contém somente parte da sessão." };
  }
  const provisioningJson = snapshot.provisioningJson;
  const branchStateJson = snapshot.branchStateJson;
  const deviceSecretHex = snapshot.deviceSecretHex;
  if (provisioningJson === null || branchStateJson === null || deviceSecretHex === null) {
    return { restored: null, error: "A instalação contém somente parte da sessão." };
  }
  try {
    return {
      restored: restoreOnchainSession(provisioningJson, branchStateJson, deviceSecretHex, expected),
      error: null,
    };
  } catch (reason) {
    return { restored: null, error: errorMessage(reason) };
  }
}

/**
 * Orchestrates local signed recovery and confirmed Solana state without owning
 * a wallet key. walletOwnerHex is supplied only after an explicit wallet/MWA
 * authorization performed by the UI boundary.
 */
export async function evaluatePayerRecovery(
  input: PayerRecoveryControllerInput,
  storage: PayerRecoveryStoragePort,
  chain: PayerRecoveryChainPort,
): Promise<PayerRecoveryControllerResult> {
  const local = await restoreLocal(storage, input.expectedEnvironment);
  if (!input.connected) {
    const decision = decideSessionAccess({ connected: false, local: local.restored?.localProvisioning ?? null, authoritative: null, walletAuthorizationConfirmed: false });
    return { decision, restoredSession: decision.outcome === "offline-ready" ? local.restored : null, localValidationError: local.error, authoritative: null };
  }

  const authorizedOwner = walletOwner(input.walletOwnerHex);
  const owner = local.restored?.localProvisioning.owner ?? authorizedOwner;
  if (owner === null) {
    return {
      decision: { outcome: "wallet-authorization-required", reason: "wallet-signature-required" },
      restoredSession: null,
      localValidationError: local.error,
      authoritative: null,
    };
  }
  if (authorizedOwner !== null && local.restored !== null && authorizedOwner !== local.restored.localProvisioning.owner) {
    return {
      decision: { outcome: "active-session-blocks-reprovisioning", reason: "active-session-local-binding-mismatch" },
      restoredSession: null,
      localValidationError: "A wallet autorizada não corresponde ao owner da sessão local.",
      authoritative: null,
    };
  }

  const authoritative = await chain.fetchConfirmedRecovery(owner);
  const decision = decideSessionAccess({
    connected: true,
    local: local.restored?.localProvisioning ?? null,
    authoritative,
    walletAuthorizationConfirmed: authorizedOwner !== null,
  });
  return {
    decision,
    restoredSession: decision.outcome === "offline-ready" ? local.restored : null,
    localValidationError: local.error,
    authoritative,
  };
}

/**
 * Durable commit barrier for a newly confirmed provisioned session. Public
 * signed material is written first and the protected device secret last. A
 * crash at any point leaves a partial record that the bootstrap rejects.
 */
export async function persistConfirmedProvisioning(storage: PayerRecoveryStoragePort, persisted: PersistedOnchainSession): Promise<void> {
  await storage.writeBranchState(persisted.branchStateJson);
  await storage.writeProvisioning(persisted.provisioningJson);
  await storage.writeProtectedDeviceSecret(persisted.deviceSecretHex);
}

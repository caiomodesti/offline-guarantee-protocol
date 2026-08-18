export type SessionAccessOutcome =
  | "offline-ready"
  | "online-recovery-required"
  | "active-session-blocks-reprovisioning"
  | "offline-access-revoked"
  | "wallet-authorization-required"
  | "new-session-allowed";

export type AuthoritativeSessionStatus =
  | "active"
  | "claim-window"
  | "reconciling"
  | "settled"
  | "conflicted"
  | "insolvent"
  | "closed";

export interface LocalProvisioningRecord {
  readonly source: "on-chain" | "development-fixture";
  readonly provisioningConfirmed: boolean;
  readonly sessionAccount: string;
  readonly sessionId: string;
  readonly branchStateSessionId: string;
  readonly owner: string;
  readonly certificateOwner: string;
  readonly devicePublicKey: string;
  readonly certificateDevicePublicKey: string;
  readonly protectedDeviceKeyPublicKey: string | null;
  readonly branchStatePresent: boolean;
}

export interface AuthoritativeRecoveryState {
  readonly confirmed: boolean;
  readonly profileOwner: string;
  readonly offlineAccessEnabled: boolean;
  readonly activeSessionAccount: string | null;
  readonly sessionAccount: string | null;
  readonly sessionId: string | null;
  readonly sessionOwner: string | null;
  readonly sessionDevicePublicKey: string | null;
  readonly sessionStatus: AuthoritativeSessionStatus | null;
}

export interface SessionAccessInput {
  readonly connected: boolean;
  readonly local: LocalProvisioningRecord | null;
  readonly authoritative: AuthoritativeRecoveryState | null;
  readonly walletAuthorizationConfirmed: boolean;
}

export interface SessionAccessDecision {
  readonly outcome: SessionAccessOutcome;
  readonly reason:
    | "complete-local-session"
    | "local-session-missing-or-invalid"
    | "chain-state-required"
    | "active-session-local-binding-missing"
    | "active-session-local-binding-mismatch"
    | "active-session-not-spendable"
    | "profile-offline-access-revoked"
    | "wallet-signature-required"
    | "authoritative-profile-free";
}

const HEX_32 = /^[0-9a-f]{64}$/;

function isHex32(value: string | null): value is string {
  return value !== null && HEX_32.test(value);
}

function isCompleteLocalRecord(local: LocalProvisioningRecord | null): local is LocalProvisioningRecord {
  if (local === null || local.source !== "on-chain" || !local.provisioningConfirmed || !local.branchStatePresent) return false;
  if (!isHex32(local.sessionAccount) || !isHex32(local.sessionId) || !isHex32(local.owner) || !isHex32(local.devicePublicKey)) return false;
  return local.sessionId === local.branchStateSessionId
    && local.owner === local.certificateOwner
    && local.devicePublicKey === local.certificateDevicePublicKey
    && local.devicePublicKey === local.protectedDeviceKeyPublicKey;
}

function authoritativeBindingIsComplete(state: AuthoritativeRecoveryState): boolean {
  if (!isHex32(state.profileOwner)) return false;
  if (state.activeSessionAccount === null) {
    return state.sessionAccount === null
      && state.sessionId === null
      && state.sessionOwner === null
      && state.sessionDevicePublicKey === null
      && state.sessionStatus === null;
  }
  return isHex32(state.activeSessionAccount)
    && state.activeSessionAccount === state.sessionAccount
    && isHex32(state.sessionId)
    && isHex32(state.sessionOwner)
    && isHex32(state.sessionDevicePublicKey)
    && state.sessionStatus !== null;
}

function localMatchesAuthority(local: LocalProvisioningRecord, state: AuthoritativeRecoveryState): boolean {
  return local.sessionAccount === state.activeSessionAccount
    && local.sessionId === state.sessionId
    && local.owner === state.profileOwner
    && local.owner === state.sessionOwner
    && local.devicePublicKey === state.sessionDevicePublicKey;
}

/**
 * Pure Sprint 8 gate. It never creates keys, sessions, balances, or fixtures.
 * Callers may act only on the returned explicit outcome.
 */
export function decideSessionAccess(input: SessionAccessInput): SessionAccessDecision {
  const completeLocal = isCompleteLocalRecord(input.local);

  if (!input.connected) {
    return completeLocal
      ? { outcome: "offline-ready", reason: "complete-local-session" }
      : { outcome: "online-recovery-required", reason: "local-session-missing-or-invalid" };
  }

  if (input.authoritative === null || !input.authoritative.confirmed || !authoritativeBindingIsComplete(input.authoritative)) {
    return { outcome: "online-recovery-required", reason: "chain-state-required" };
  }

  const authority = input.authoritative;
  if (!authority.offlineAccessEnabled) {
    return { outcome: "offline-access-revoked", reason: "profile-offline-access-revoked" };
  }
  if (authority.activeSessionAccount !== null) {
    if (!completeLocal) {
      return { outcome: "active-session-blocks-reprovisioning", reason: "active-session-local-binding-missing" };
    }
    if (!localMatchesAuthority(input.local, authority)) {
      return { outcome: "active-session-blocks-reprovisioning", reason: "active-session-local-binding-mismatch" };
    }
    if (authority.sessionStatus !== "active") {
      return { outcome: "active-session-blocks-reprovisioning", reason: "active-session-not-spendable" };
    }
    return { outcome: "offline-ready", reason: "complete-local-session" };
  }

  if (!input.walletAuthorizationConfirmed) {
    return { outcome: "wallet-authorization-required", reason: "wallet-signature-required" };
  }
  return { outcome: "new-session-allowed", reason: "authoritative-profile-free" };
}

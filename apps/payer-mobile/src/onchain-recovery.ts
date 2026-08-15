import {
  decodeOfflineSession,
  decodeUserProfile,
  type DecodedOfflineSession,
  type SessionStatus,
} from "@ogp/protocol-sdk";
import type { AuthoritativeRecoveryState, AuthoritativeSessionStatus } from "./session-access";

export interface RawProgramAccount {
  readonly address: Uint8Array;
  readonly ownerProgramId: Uint8Array;
  readonly data: Uint8Array;
}

export interface RecoveryAccountSnapshot {
  readonly confirmed: boolean;
  readonly expectedProgramId: Uint8Array;
  readonly expectedProfileAddress: Uint8Array;
  readonly profile: RawProgramAccount;
  readonly session: RawProgramAccount | null;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

function accessStatus(status: SessionStatus): AuthoritativeSessionStatus {
  return status === "claimWindow" ? "claim-window" : status;
}

function assertOwnedAccount(account: RawProgramAccount, expectedAddress: Uint8Array, expectedProgramId: Uint8Array, name: string): void {
  if (!equalBytes(account.address, expectedAddress)) throw new Error(`${name} address mismatch`);
  if (!equalBytes(account.ownerProgramId, expectedProgramId)) throw new Error(`${name} owner program mismatch`);
}

function sessionState(session: DecodedOfflineSession): Pick<AuthoritativeRecoveryState, "sessionId" | "sessionOwner" | "sessionDevicePublicKey" | "sessionStatus"> {
  return {
    sessionId: hex(session.sessionId),
    sessionOwner: hex(session.owner),
    sessionDevicePublicKey: hex(session.devicePublicKey),
    sessionStatus: accessStatus(session.status),
  };
}

/** Strict adapter from confirmed Solana account envelopes to the pure access gate. */
export function authoritativeRecoveryFromAccounts(snapshot: RecoveryAccountSnapshot): AuthoritativeRecoveryState {
  assertOwnedAccount(snapshot.profile, snapshot.expectedProfileAddress, snapshot.expectedProgramId, "UserProfile");
  const profile = decodeUserProfile(snapshot.profile.data);

  if (isZero(profile.activeSession)) {
    if (snapshot.session !== null) throw new Error("unexpected OfflineSession for a profile without active_session");
    return {
      confirmed: snapshot.confirmed,
      profileOwner: hex(profile.owner),
      offlineAccessEnabled: profile.offlineAccessEnabled,
      activeSessionAccount: null,
      sessionAccount: null,
      sessionId: null,
      sessionOwner: null,
      sessionDevicePublicKey: null,
      sessionStatus: null,
    };
  }

  if (snapshot.session === null) throw new Error("active_session requires its OfflineSession account");
  assertOwnedAccount(snapshot.session, profile.activeSession, snapshot.expectedProgramId, "OfflineSession");
  const session = decodeOfflineSession(snapshot.session.data);
  return {
    confirmed: snapshot.confirmed,
    profileOwner: hex(profile.owner),
    offlineAccessEnabled: profile.offlineAccessEnabled,
    activeSessionAccount: hex(profile.activeSession),
    sessionAccount: hex(snapshot.session.address),
    ...sessionState(session),
  };
}


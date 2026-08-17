import { describe, expect, it } from "vitest";
import {
  OFFLINE_SESSION_ACCOUNT_SIZE,
  OFFLINE_SESSION_DISCRIMINATOR,
  USER_PROFILE_ACCOUNT_SIZE,
  USER_PROFILE_DISCRIMINATOR,
} from "@ogp/protocol-sdk";
import { authoritativeRecoveryFromAccounts, type RawProgramAccount } from "../../apps/payer-mobile/src/onchain-recovery.js";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const hex = (value: number): string => value.toString(16).padStart(2, "0").repeat(32);

function profileData(activeSession: Uint8Array, offlineAccessEnabled = true): Uint8Array {
  const data = new Uint8Array(USER_PROFILE_ACCOUNT_SIZE);
  data.set(USER_PROFILE_DISCRIMINATOR);
  data.set(bytes(0x22), 8);
  data[105] = offlineAccessEnabled ? 1 : 0;
  data.set(activeSession, 130);
  return data;
}

function sessionData(status = 0): Uint8Array {
  const data = new Uint8Array(OFFLINE_SESSION_ACCOUNT_SIZE);
  data.set(OFFLINE_SESSION_DISCRIMINATOR);
  data.set(bytes(0x44), 8);
  data.set(bytes(0x22), 40);
  data.set(bytes(0x55), 72);
  data[188] = status;
  return data;
}

function account(address: Uint8Array, ownerProgramId: Uint8Array, data: Uint8Array): RawProgramAccount {
  return { address, ownerProgramId, data };
}

describe("confirmed Solana recovery account adapter", () => {
  const program = bytes(0x11);
  const profileAddress = bytes(0x33);
  const sessionAddress = bytes(0x66);

  it("keeps the session PDA and protocol session_id as separate verified bindings", () => {
    const recovery = authoritativeRecoveryFromAccounts({
      confirmed: true,
      expectedProgramId: program,
      expectedProfileAddress: profileAddress,
      expectedOwner: bytes(0x22),
      profile: account(profileAddress, program, profileData(sessionAddress)),
      session: account(sessionAddress, program, sessionData()),
    });

    expect(recovery).toMatchObject({
      confirmed: true,
      profileOwner: hex(0x22),
      activeSessionAccount: hex(0x66),
      sessionAccount: hex(0x66),
      sessionId: hex(0x44),
      sessionDevicePublicKey: hex(0x55),
      sessionStatus: "active",
    });
    expect(recovery.activeSessionAccount).not.toBe(recovery.sessionId);
  });

  it("represents a profile with no active session without inventing session state", () => {
    expect(authoritativeRecoveryFromAccounts({
      confirmed: true,
      expectedProgramId: program,
      expectedProfileAddress: profileAddress,
      expectedOwner: bytes(0x22),
      profile: account(profileAddress, program, profileData(bytes(0))),
      session: null,
    })).toMatchObject({ activeSessionAccount: null, sessionId: null, offlineAccessEnabled: true });
  });

  it("rejects program-owner substitution, address substitution, and a missing active session account", () => {
    const base = {
      confirmed: true,
      expectedProgramId: program,
      expectedProfileAddress: profileAddress,
      expectedOwner: bytes(0x22),
      profile: account(profileAddress, program, profileData(sessionAddress)),
      session: account(sessionAddress, program, sessionData()),
    };
    expect(() => authoritativeRecoveryFromAccounts({ ...base, profile: account(profileAddress, bytes(0x99), profileData(sessionAddress)) }))
      .toThrow(/owner program mismatch/);
    expect(() => authoritativeRecoveryFromAccounts({ ...base, profile: account(bytes(0x88), program, profileData(sessionAddress)) }))
      .toThrow(/address mismatch/);
    expect(() => authoritativeRecoveryFromAccounts({ ...base, expectedOwner: bytes(0x77) }))
      .toThrow(/owner mismatch/);
    expect(() => authoritativeRecoveryFromAccounts({ ...base, session: null })).toThrow(/requires its OfflineSession/);
  });

  it("preserves authoritative revocation and non-active status", () => {
    const recovery = authoritativeRecoveryFromAccounts({
      confirmed: true,
      expectedProgramId: program,
      expectedProfileAddress: profileAddress,
      expectedOwner: bytes(0x22),
      profile: account(profileAddress, program, profileData(sessionAddress, false)),
      session: account(sessionAddress, program, sessionData(1)),
    });
    expect(recovery.offlineAccessEnabled).toBe(false);
    expect(recovery.sessionStatus).toBe("claim-window");
  });
});

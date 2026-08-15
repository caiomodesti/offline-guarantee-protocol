import { describe, expect, it } from "vitest";
import {
  decideSessionAccess,
  type AuthoritativeRecoveryState,
  type LocalProvisioningRecord,
} from "../../apps/payer-mobile/src/session-access.js";

const hex = (value: string): string => value.repeat(64);

const local: LocalProvisioningRecord = {
  source: "on-chain",
  provisioningConfirmed: true,
  sessionAccount: hex("d"),
  sessionId: hex("a"),
  branchStateSessionId: hex("a"),
  owner: hex("b"),
  certificateOwner: hex("b"),
  devicePublicKey: hex("c"),
  certificateDevicePublicKey: hex("c"),
  protectedDeviceKeyPublicKey: hex("c"),
  branchStatePresent: true,
};

const active: AuthoritativeRecoveryState = {
  confirmed: true,
  profileOwner: hex("b"),
  offlineAccessEnabled: true,
  activeSessionAccount: hex("d"),
  sessionAccount: hex("d"),
  sessionId: hex("a"),
  sessionOwner: hex("b"),
  sessionDevicePublicKey: hex("c"),
  sessionStatus: "active",
};

const free: AuthoritativeRecoveryState = {
  confirmed: true,
  profileOwner: hex("b"),
  offlineAccessEnabled: true,
  activeSessionAccount: null,
  sessionAccount: null,
  sessionId: null,
  sessionOwner: null,
  sessionDevicePublicKey: null,
  sessionStatus: null,
};

describe("Sprint 8 fail-closed payer session access", () => {
  it("allows offline payment only with a complete on-chain provisioned local binding", () => {
    expect(decideSessionAccess({ connected: false, local, authoritative: null, walletAuthorizationConfirmed: false })).toEqual({
      outcome: "offline-ready",
      reason: "complete-local-session",
    });
  });

  it("requires online recovery after app data or protected key loss", () => {
    expect(decideSessionAccess({ connected: false, local: null, authoritative: null, walletAuthorizationConfirmed: false }).outcome)
      .toBe("online-recovery-required");
    expect(decideSessionAccess({
      connected: false,
      local: { ...local, protectedDeviceKeyPublicKey: null },
      authoritative: null,
      walletAuthorizationConfirmed: false,
    }).outcome).toBe("online-recovery-required");
  });

  it("never accepts the Sprint 7 development fixture in the on-chain gate", () => {
    expect(decideSessionAccess({
      connected: false,
      local: { ...local, source: "development-fixture" },
      authoritative: null,
      walletAuthorizationConfirmed: false,
    }).outcome).toBe("online-recovery-required");
  });

  it("blocks reprovisioning while an authoritative prior session survives local data loss", () => {
    expect(decideSessionAccess({ connected: true, local: null, authoritative: active, walletAuthorizationConfirmed: true })).toEqual({
      outcome: "active-session-blocks-reprovisioning",
      reason: "active-session-local-binding-missing",
    });
  });

  it("blocks partial backup restoration and non-active session reuse", () => {
    expect(decideSessionAccess({
      connected: true,
      local: { ...local, sessionId: hex("d"), branchStateSessionId: hex("d") },
      authoritative: active,
      walletAuthorizationConfirmed: true,
    }).reason).toBe("active-session-local-binding-mismatch");
    expect(decideSessionAccess({
      connected: true,
      local,
      authoritative: { ...active, sessionStatus: "claim-window" },
      walletAuthorizationConfirmed: true,
    }).reason).toBe("active-session-not-spendable");
  });

  it("honors authoritative offline-access revocation", () => {
    expect(decideSessionAccess({
      connected: true,
      local,
      authoritative: { ...active, offlineAccessEnabled: false },
      walletAuthorizationConfirmed: true,
    })).toEqual({
      outcome: "offline-access-revoked",
      reason: "profile-offline-access-revoked",
    });
  });

  it("requires a wallet signature before a confirmed free profile may create a new session", () => {
    expect(decideSessionAccess({ connected: true, local: null, authoritative: free, walletAuthorizationConfirmed: false }).outcome)
      .toBe("wallet-authorization-required");
    expect(decideSessionAccess({ connected: true, local: null, authoritative: free, walletAuthorizationConfirmed: true })).toEqual({
      outcome: "new-session-allowed",
      reason: "authoritative-profile-free",
    });
  });

  it("fails closed when an online chain read is absent or unconfirmed and blocks a local mismatch", () => {
    expect(decideSessionAccess({ connected: true, local, authoritative: null, walletAuthorizationConfirmed: true }).outcome)
      .toBe("online-recovery-required");
    expect(decideSessionAccess({ connected: true, local, authoritative: { ...active, confirmed: false }, walletAuthorizationConfirmed: true }).outcome)
      .toBe("online-recovery-required");
    expect(decideSessionAccess({ connected: true, local, authoritative: { ...active, sessionId: hex("d") }, walletAuthorizationConfirmed: true }).outcome)
      .toBe("active-session-blocks-reprovisioning");
  });
});

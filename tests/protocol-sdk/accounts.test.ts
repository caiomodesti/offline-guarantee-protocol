import { describe, expect, it } from "vitest";
import {
  CLAIM_ACCOUNT_SIZE,
  CLAIM_DISCRIMINATOR,
  ED25519_SIGNATURE_SIZE,
  OFFLINE_SESSION_ACCOUNT_SIZE,
  OFFLINE_SESSION_DISCRIMINATOR,
  PAYMENT_CREDENTIAL_PAYLOAD_SIZE,
  STATE_EDGE_RECORD_ACCOUNT_SIZE,
  STATE_EDGE_RECORD_DISCRIMINATOR,
  USER_PROFILE_ACCOUNT_SIZE,
  USER_PROFILE_DISCRIMINATOR,
  decodeClaim,
  decodeOfflineSession,
  decodeStateEdgeRecord,
  decodeUserProfile,
  createClaimSubmissionMaterial,
} from "@ogp/protocol-sdk";
import { makeFixture } from "../crypto/fixture.js";

describe("protocol account decoders", () => {
  it("bridges the exact merchant-verified credential bytes to submit_claim", () => {
    const fixture = makeFixture();
    const material = createClaimSubmissionMaterial(fixture.credential);
    expect(material.payload).toHaveLength(PAYMENT_CREDENTIAL_PAYLOAD_SIZE);
    expect(material.payerSignature).toHaveLength(ED25519_SIGNATURE_SIZE);
    expect(material.credentialHash).toHaveLength(32);
    expect(material.payerSignature).toEqual(fixture.credential.payerSignature);
  });

  it("decodes the authoritative UserProfile recovery fields", () => {
    const data = new Uint8Array(USER_PROFILE_ACCOUNT_SIZE);
    data.set(USER_PROFILE_DISCRIMINATOR);
    data.fill(0xaa, 8, 40);
    data.fill(0xbb, 130, 162);
    const view = new DataView(data.buffer);
    view.setUint8(105, 1);
    view.setUint32(106, 4, true);
    view.setBigInt64(122, 1_900_000_000n, true);
    view.setUint8(162, 252);

    expect(decodeUserProfile(data)).toMatchObject({
      offlineAccessEnabled: true,
      successfulSessions: 4,
      identityExpiresAt: 1_900_000_000n,
      bump: 252,
    });
    expect(decodeUserProfile(data).activeSession).toEqual(new Uint8Array(32).fill(0xbb));
  });

  it("decodes the authoritative OfflineSession recovery and economic fields", () => {
    const data = new Uint8Array(OFFLINE_SESSION_ACCOUNT_SIZE);
    data.set(OFFLINE_SESSION_DISCRIMINATOR);
    data.fill(0xaa, 8, 40);
    data.fill(0xbb, 40, 72);
    data.fill(0xcc, 72, 104);
    const view = new DataView(data.buffer);
    view.setBigUint64(136, 300n, true);
    view.setBigUint64(144, 100n, true);
    view.setBigUint64(152, 300n, true);
    view.setUint32(160, 32, true);
    view.setBigInt64(164, 1_000n, true);
    view.setBigInt64(172, 11_800n, true);
    view.setBigInt64(180, 33_400n, true);
    view.setUint8(188, 0);
    view.setUint8(190, 0);
    view.setBigUint64(368, 2n, true);
    view.setUint8(529, 1);

    expect(decodeOfflineSession(data)).toMatchObject({
      collateralLocked: 300n,
      branchSpendingLimit: 100n,
      collateralCoverageCap: 300n,
      maxBranchDepth: 32,
      issuedAt: 1_000n,
      expiresAt: 11_800n,
      claimSubmissionDeadline: 33_400n,
      status: "active",
      coverageStatus: "uncalculated",
      submittedClaimCount: 2n,
      allocationComplete: true,
    });
  });

  it("decodes the fixed Claim layout", () => {
    const data = new Uint8Array(CLAIM_ACCOUNT_SIZE);
    data.set(CLAIM_DISCRIMINATOR);
    const view = new DataView(data.buffer);
    view.setBigUint64(104, 25n, true);
    view.setUint32(112, 7, true);
    view.setBigUint64(180, 99n, true);
    view.setUint8(188, 4);
    view.setUint8(189, 1);
    view.setUint8(206, 254);
    view.setUint8(271, 1);

    expect(decodeClaim(data)).toMatchObject({
      amount: 25n,
      sequence: 7,
      submittedSlot: 99n,
      status: "rejected",
      rejectionReason: "duplicateStateEdge",
      bump: 254,
      allocationProcessed: true,
    });
  });

  it("decodes the fixed StateEdgeRecord layout", () => {
    const data = new Uint8Array(STATE_EDGE_RECORD_ACCOUNT_SIZE);
    data.set(STATE_EDGE_RECORD_DISCRIMINATOR);
    const view = new DataView(data.buffer);
    view.setUint32(72, 3, true);
    view.setBigUint64(140, 40n, true);
    view.setUint32(196, 2, true);
    view.setUint8(224, 253);
    view.setUint8(225, 1);
    view.setUint8(226, 1);

    expect(decodeStateEdgeRecord(data)).toMatchObject({
      sequence: 3,
      amount: 40n,
      wrapperCount: 2,
      bump: 253,
      classified: true,
      conflicting: true,
    });
  });

  it("rejects the wrong length or discriminator", () => {
    expect(() => decodeUserProfile(new Uint8Array(USER_PROFILE_ACCOUNT_SIZE - 1))).toThrow(/exactly/);
    expect(() => decodeOfflineSession(new Uint8Array(OFFLINE_SESSION_ACCOUNT_SIZE))).toThrow(/discriminator/);
    expect(() => decodeClaim(new Uint8Array(CLAIM_ACCOUNT_SIZE - 1))).toThrow(/exactly/);
    expect(() => decodeStateEdgeRecord(new Uint8Array(STATE_EDGE_RECORD_ACCOUNT_SIZE))).toThrow(/discriminator/);
  });
});

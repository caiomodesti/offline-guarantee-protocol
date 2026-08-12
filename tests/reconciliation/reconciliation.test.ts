import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyPayment, createGenesisState } from "@ogp/offline-ledger";
import { credentialHash } from "@ogp/credentials";
import { reconcileSession } from "@ogp/reconciliation";
import type { PaymentCredential } from "@ogp/shared-types";
import { makeFixture, type ProtocolFixture } from "../crypto/fixture.js";

const filled = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const parentOf = (credential: PaymentCredential) => ({
  stateHash: credential.newStateHash,
  sequence: credential.sequence,
  remaining: credential.newRemaining,
});

function sibling(fixture: ProtocolFixture, marker: number, amount: bigint): PaymentCredential {
  return applyPayment(fixture.context, fixture.certificate, fixture.parent, {
    merchant: filled(0x20 + marker),
    merchantDeviceKey: filled(0x30 + marker),
    amount,
    merchantChallenge: filled(0x40 + marker),
    createdAt: fixture.certificate.issuedAt + BigInt(100 + marker),
  }, fixture.deviceSecret);
}

function descendant(fixture: ProtocolFixture, parent: PaymentCredential, marker: number, amount: bigint): PaymentCredential {
  return applyPayment(fixture.context, fixture.certificate, parentOf(parent), {
    merchant: filled(0x60 + marker),
    merchantDeviceKey: filled(0x70 + marker),
    amount,
    merchantChallenge: filled(0x80 + marker),
    createdAt: fixture.certificate.issuedAt + BigInt(200 + marker),
  }, fixture.deviceSecret);
}

function reconcile(fixture: ProtocolFixture, credentials: readonly PaymentCredential[]) {
  return reconcileSession({
    context: fixture.context,
    sessionCertificate: fixture.certificate,
    deviceAuthorization: fixture.authorization,
    credentials,
  });
}

describe("Sprint 5 deterministic reconciliation", () => {
  it("classifies a normal branch and calculates unique exposure", () => {
    const fixture = makeFixture(100n);
    const second = descendant(fixture, fixture.credential, 1, 50n);
    const result = reconcile(fixture, [second, fixture.credential]);

    expect(result.validClaims).toHaveLength(2);
    expect(result.conflictingClaims).toHaveLength(0);
    expect(result.aggregateOfflineExposure).toBe(150n);
    expect(result.conflictingExposure).toBe(0n);
    expect(result.stateGraphCommitment).toHaveLength(32);
  });

  it("marks fork siblings and all descendants conflicting, not the common prefix", () => {
    const fixture = makeFixture(100n);
    const common = fixture.credential;
    const branchA = descendant(fixture, common, 1, 40n);
    const branchB = applyPayment(fixture.context, fixture.certificate, parentOf(common), {
      merchant: filled(0x25), merchantDeviceKey: filled(0x35), amount: 60n,
      merchantChallenge: filled(0x45), createdAt: fixture.certificate.issuedAt + 150n,
    }, fixture.deviceSecret);
    const branchA2 = descendant(fixture, branchA, 2, 20n);
    const result = reconcile(fixture, [branchA2, branchB, common, branchA]);

    expect(result.forks).toHaveLength(1);
    expect(result.validClaims.map((claim) => hex(claim.edge.credentialHash))).toEqual([hex(credentialHash(common))]);
    expect(result.conflictingClaims).toHaveLength(3);
    expect(result.aggregateOfflineExposure).toBe(220n);
    expect(result.conflictingExposure).toBe(120n);
  });

  it("handles triple forks while excluding replay, duplicate edges, and invalid evidence", () => {
    const fixture = makeFixture(100n);
    const branchB = sibling(fixture, 2, 200n);
    const branchC = sibling(fixture, 3, 300n);
    const equivalent = applyPayment(fixture.context, fixture.certificate, fixture.parent, {
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
      amount: fixture.credential.amount,
      merchantChallenge: fixture.credential.merchantChallenge,
      createdAt: fixture.credential.createdAt + 1n,
    }, fixture.deviceSecret);
    const badSignature = fixture.credential.payerSignature.slice();
    badSignature[0] = (badSignature[0] ?? 0) ^ 1;
    const invalid = { ...fixture.credential, payerSignature: badSignature };
    const result = reconcile(fixture, [invalid, equivalent, branchC, fixture.credential, branchB, fixture.credential]);

    expect(result.forks[0]?.branchCount).toBe(3);
    expect(result.eligibleClaims).toHaveLength(3);
    expect(result.conflictingClaims).toHaveLength(3);
    expect(result.duplicateCredentials.map((entry) => entry.reason).sort()).toEqual(["DUPLICATE_CREDENTIAL", "DUPLICATE_STATE_EDGE"]);
    expect(result.invalidCredentials).toHaveLength(1);
    expect(result.aggregateOfflineExposure).toBe(600n);
  });

  it("is invariant to arrival order", () => {
    const fixture = makeFixture(100n);
    const branchB = sibling(fixture, 2, 120n);
    const child = descendant(fixture, fixture.credential, 4, 30n);
    const credentials = [fixture.credential, branchB, child, fixture.credential];
    const expected = reconcile(fixture, credentials);
    const digest = (result: ReturnType<typeof reconcile>) => ({
      commitment: hex(result.stateGraphCommitment),
      eligible: result.eligibleClaims.map((claim) => [hex(claim.edge.credentialHash), claim.classification]),
      exposure: result.aggregateOfflineExposure.toString(),
      conflicting: result.conflictingExposure.toString(),
    });

    fc.assert(fc.property(
      fc.shuffledSubarray(credentials, { minLength: credentials.length, maxLength: credentials.length }),
      (permutation) => {
        expect(digest(reconcile(fixture, permutation))).toEqual(digest(expected));
      },
    ), { numRuns: 32 });
  });

  it("binds the graph commitment to the authenticated genesis", () => {
    const fixture = makeFixture();
    const result = reconcile(fixture, [fixture.credential]);
    expect(hex(result.stateGraph.genesis.stateHash)).toBe(hex(createGenesisState(fixture.context, fixture.certificate).stateHash));
  });
});

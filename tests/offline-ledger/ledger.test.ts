import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { equalBytes, type PaymentCredential } from "@ogp/shared-types";
import { credentialHash } from "@ogp/credentials";
import { applyPayment, buildStateGraph, createGenesisState, detectForks, verifyStateTransition, type StateGraph } from "@ogp/offline-ledger";
import { makeFixture, type ProtocolFixture } from "../crypto/fixture.js";

const filled = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

function parentOf(credential: PaymentCredential) {
  return { stateHash: credential.newStateHash, sequence: credential.sequence, remaining: credential.newRemaining };
}

function nextPayment(fixture: ProtocolFixture, parent: ReturnType<typeof parentOf>, sequenceMarker: number, amount = 100n): PaymentCredential {
  return applyPayment(fixture.context, fixture.certificate, parent, {
    merchant: filled(0x30 + sequenceMarker),
    merchantDeviceKey: filled(0x40 + sequenceMarker),
    amount,
    merchantChallenge: filled(0x50 + sequenceMarker),
    createdAt: fixture.certificate.issuedAt + BigInt(100 + sequenceMarker),
  }, fixture.deviceSecret);
}

function graph(fixture: ProtocolFixture, credentials: readonly PaymentCredential[]): StateGraph {
  return buildStateGraph({ context: fixture.context, sessionCertificate: fixture.certificate, deviceAuthorization: fixture.authorization, credentials });
}

function graphDigest(value: StateGraph): unknown {
  return {
    nodes: value.nodes.map((node) => [hex(node.stateHash), node.sequence, node.remaining.toString()]),
    edges: value.edges.map((edge) => [hex(edge.credentialHash), hex(edge.parentStateHash), hex(edge.childStateHash), edge.sequence]),
    invalid: value.invalidCredentials.map((entry) => [entry.credentialHash === null ? null : hex(entry.credentialHash), entry.reason]),
    duplicates: value.duplicateCredentials.map((entry) => [hex(entry.credentialHash), hex(entry.canonicalCredentialHash), entry.reason]),
    forks: value.forks.map((fork) => [hex(fork.parentStateHash), fork.sequence, fork.childStateHashes.map(hex)]),
  };
}

describe("offline ledger state transitions", () => {
  it("creates the exact certificate-committed H0 genesis", () => {
    const fixture = makeFixture();
    const genesis = createGenesisState(fixture.context, fixture.certificate);
    expect(genesis.sequence).toBe(0);
    expect(genesis.remaining).toBe(fixture.certificate.branchSpendingLimit);
    expect(equalBytes(genesis.stateHash, fixture.certificate.genesisStateHash)).toBe(true);
  });

  it("accepts H0 -> H1 -> H2 even when credentials arrive out of order", () => {
    const fixture = makeFixture();
    const second = nextPayment(fixture, parentOf(fixture.credential), 2, 150n);
    const result = graph(fixture, [second, fixture.credential]);
    expect(result.edges).toHaveLength(2);
    expect(result.nodes).toHaveLength(3);
    expect(result.invalidCredentials).toHaveLength(0);
    expect(result.duplicateCredentials).toHaveLength(0);
    expect(result.forks).toHaveLength(0);
    expect(result.nodes.at(-1)?.sequence).toBe(2);
  });

  it("applies and verifies the same deterministic transition", () => {
    const fixture = makeFixture();
    const verified = verifyStateTransition(fixture.context, fixture.certificate, fixture.parent, fixture.credential);
    expect(equalBytes(verified.edge.credentialHash, credentialHash(fixture.credential))).toBe(true);
    expect(verified.nextState.remaining).toBe(600n);
    expect(() => verifyStateTransition(fixture.context, fixture.certificate, fixture.parent, { ...fixture.credential, amount: fixture.credential.amount + 1n })).toThrow();
  });
});

describe("offline ledger replay and fork semantics", () => {
  it("classifies an identical credential replay without creating a fork", () => {
    const fixture = makeFixture();
    const result = graph(fixture, [fixture.credential, fixture.credential]);
    expect(result.edges).toHaveLength(1);
    expect(result.duplicateCredentials).toHaveLength(1);
    expect(result.duplicateCredentials[0]?.reason).toBe("DUPLICATE_CREDENTIAL");
    expect(result.forks).toHaveLength(0);
  });

  it("detects a simple fork and a triple fork", () => {
    const fixture = makeFixture(100n, 0x21, 0x31);
    const siblingB = applyPayment(fixture.context, fixture.certificate, fixture.parent, { merchant: filled(0x22), merchantDeviceKey: filled(0x32), amount: 200n, merchantChallenge: filled(0x42), createdAt: fixture.certificate.issuedAt + 102n }, fixture.deviceSecret);
    const siblingC = applyPayment(fixture.context, fixture.certificate, fixture.parent, { merchant: filled(0x23), merchantDeviceKey: filled(0x33), amount: 300n, merchantChallenge: filled(0x43), createdAt: fixture.certificate.issuedAt + 103n }, fixture.deviceSecret);
    const simple = graph(fixture, [siblingB, fixture.credential]);
    const triple = graph(fixture, [siblingC, fixture.credential, siblingB]);
    expect(simple.forks).toHaveLength(1);
    expect(simple.forks[0]).toMatchObject({ sequence: 1, branchCount: 2 });
    expect(detectForks(simple)).toHaveLength(1);
    expect(triple.forks).toHaveLength(1);
    expect(triple.forks[0]).toMatchObject({ sequence: 1, branchCount: 3 });
  });

  it("does not let an invalid sibling fabricate an authenticated fork", () => {
    const fixture = makeFixture();
    const signature = fixture.credential.payerSignature.slice();
    signature[0] = (signature[0] ?? 0) ^ 1;
    const invalidSibling = { ...fixture.credential, newStateHash: filled(0xee), payerSignature: signature };
    const result = graph(fixture, [fixture.credential, invalidSibling]);
    expect(result.edges).toHaveLength(1);
    expect(result.invalidCredentials).toHaveLength(1);
    expect(result.forks).toHaveLength(0);
  });

  it("finds the earliest fork instead of treating equal later sequences as siblings", () => {
    const fixture = makeFixture(100n, 0x21, 0x31);
    const branchB = applyPayment(fixture.context, fixture.certificate, fixture.parent, { merchant: filled(0x22), merchantDeviceKey: filled(0x32), amount: 120n, merchantChallenge: filled(0x42), createdAt: fixture.certificate.issuedAt + 102n }, fixture.deviceSecret);
    const branchA2 = nextPayment(fixture, parentOf(fixture.credential), 2, 30n);
    const branchB2 = nextPayment(fixture, parentOf(branchB), 3, 40n);
    const result = graph(fixture, [branchA2, branchB2, branchB, fixture.credential]);
    expect(result.edges).toHaveLength(4);
    expect(result.forks).toHaveLength(1);
    expect(result.forks[0]).toMatchObject({ sequence: 1, branchCount: 2 });
  });

  it("classifies two signed wrappers for the same state edge as one economic edge", () => {
    const fixture = makeFixture();
    const equivalent = applyPayment(fixture.context, fixture.certificate, fixture.parent, { merchant: fixture.credential.merchant, merchantDeviceKey: fixture.credential.merchantDeviceKey, amount: fixture.credential.amount, merchantChallenge: fixture.credential.merchantChallenge, createdAt: fixture.credential.createdAt + 1n }, fixture.deviceSecret);
    expect(equalBytes(equivalent.newStateHash, fixture.credential.newStateHash)).toBe(true);
    expect(equalBytes(credentialHash(equivalent), credentialHash(fixture.credential))).toBe(false);
    const result = graph(fixture, [equivalent, fixture.credential]);
    expect(result.edges).toHaveLength(1);
    expect(result.duplicateCredentials).toHaveLength(1);
    expect(result.duplicateCredentials[0]?.reason).toBe("DUPLICATE_STATE_EDGE");
    expect(result.forks).toHaveLength(0);
    const hashes = [hex(credentialHash(equivalent)), hex(credentialHash(fixture.credential))].sort();
    expect(hex(result.edges[0]?.credentialHash ?? new Uint8Array())).toBe(hashes[0]);
  });

  it("rejects a cryptographically valid descendant whose parent was not supplied", () => {
    const fixture = makeFixture();
    const second = nextPayment(fixture, parentOf(fixture.credential), 2, 50n);
    const result = graph(fixture, [second]);
    expect(result.edges).toHaveLength(0);
    expect(result.invalidCredentials[0]?.reason).toBe("INVALID_PARENT");
    expect(result.forks).toHaveLength(0);
  });

  it("classifies malformed byte lengths instead of aborting graph reconstruction", () => {
    const fixture = makeFixture();
    const malformed = { ...fixture.credential, payerSignature: new Uint8Array(63) };
    const result = graph(fixture, [malformed, fixture.credential]);
    expect(result.edges).toHaveLength(1);
    expect(result.invalidCredentials).toHaveLength(1);
    expect(result.invalidCredentials[0]?.credentialHash).toBeNull();
    expect(result.invalidCredentials[0]?.reason).toBe("INVALID_LENGTH");
  });
});

describe("deterministic graph reconstruction", () => {
  it("is invariant to credential arrival order", () => {
    const fixture = makeFixture(100n, 0x21, 0x31);
    const sibling = applyPayment(fixture.context, fixture.certificate, fixture.parent, { merchant: filled(0x22), merchantDeviceKey: filled(0x32), amount: 120n, merchantChallenge: filled(0x42), createdAt: fixture.certificate.issuedAt + 102n }, fixture.deviceSecret);
    const descendant = nextPayment(fixture, parentOf(fixture.credential), 2, 30n);
    const credentials = [fixture.credential, sibling, descendant, fixture.credential];
    const expected = graphDigest(graph(fixture, credentials));
    fc.assert(fc.property(fc.shuffledSubarray(credentials, { minLength: credentials.length, maxLength: credentials.length }), (permutation) => {
      expect(graphDigest(graph(fixture, permutation))).toEqual(expected);
    }), { numRuns: 32 });
  });
});

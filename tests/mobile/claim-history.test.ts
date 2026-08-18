import { describe, expect, it } from "vitest";
import { createStoredClaim, findPotentialConflictHashes, markReceiptShown, parseStoredClaims } from "../../apps/merchant-mobile/src/claim-history.js";

const hash = (value: string): string => value.repeat(64);

describe("merchant claim history", () => {
  it("migrates legacy claims without claiming that their receipt was shown", () => {
    const claims = parseStoredClaims(JSON.stringify([{
      credentialHash: hash("a"),
      amount: "50",
      sessionId: hash("b"),
      frames: ["frame"],
      status: "pending-settlement",
    }]));

    expect(claims).toHaveLength(1);
    expect(claims[0]?.receiptPresentation).toBe("unknown");
    expect(claims[0]?.status).toBe("pending-submission");
    expect(claims[0]?.submissionAttempts).toBe(0);
  });

  it("creates new durable proofs without pretending they were submitted or settled", () => {
    const stored = createStoredClaim({
      credentialHash: hash("a"),
      amount: "50",
      sessionId: hash("b"),
      frames: ["frame"],
    });

    expect(stored).toMatchObject({
      status: "pending-submission",
      receiptPresentation: "not-shown",
      submissionAttempts: 0,
      transactionSignature: null,
      lastConfirmedSlot: null,
      lastSubmissionError: null,
    });
  });

  it("records receipt presentation without representing payer acknowledgement", () => {
    const claims = parseStoredClaims(JSON.stringify([{
      credentialHash: hash("a"),
      amount: "50",
      sessionId: hash("b"),
      frames: ["frame"],
      status: "pending-settlement",
      receiptPresentation: "not-shown",
    }]));

    expect(markReceiptShown(claims, hash("a"))[0]?.receiptPresentation).toBe("shown");
  });

  it("flags a formal local fork candidate but ignores replay and normal branches", () => {
    const shared = { sessionId: hash("1"), parentStateHash: hash("2"), sequence: 1 };
    const conflict = findPotentialConflictHashes([
      { ...shared, credentialHash: hash("a"), resultingStateHash: hash("3") },
      { ...shared, credentialHash: hash("b"), resultingStateHash: hash("4") },
      { ...shared, credentialHash: hash("c"), resultingStateHash: hash("3") },
      { sessionId: hash("1"), parentStateHash: hash("3"), sequence: 2, credentialHash: hash("d"), resultingStateHash: hash("5") },
    ]);

    expect([...conflict].sort()).toEqual([hash("a"), hash("b"), hash("c")].sort());
    expect(conflict.has(hash("d"))).toBe(false);
  });

  it("flags descendant claims when the conflicting edge is earlier in their complete bundles", () => {
    const conflict = findPotentialConflictHashes([
      { sessionId: hash("1"), parentStateHash: hash("2"), sequence: 1, credentialHash: hash("a"), resultingStateHash: hash("3") },
      { sessionId: hash("1"), parentStateHash: hash("3"), sequence: 2, credentialHash: hash("a"), resultingStateHash: hash("5") },
      { sessionId: hash("1"), parentStateHash: hash("2"), sequence: 1, credentialHash: hash("b"), resultingStateHash: hash("4") },
      { sessionId: hash("1"), parentStateHash: hash("4"), sequence: 2, credentialHash: hash("b"), resultingStateHash: hash("6") },
    ]);

    expect([...conflict].sort()).toEqual([hash("a"), hash("b")].sort());
  });

  it("drops malformed local entries instead of presenting them as verified", () => {
    expect(parseStoredClaims("not-json")).toEqual([]);
    expect(parseStoredClaims(JSON.stringify([{ credentialHash: "bad" }]))).toEqual([]);
  });
});

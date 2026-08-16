import { describe, expect, it, vi } from "vitest";
import { createStoredClaim, type StoredClaim } from "../../apps/merchant-mobile/src/claim-history.js";
import {
  syncClaimQueue,
  syncStoredClaim,
  type AuthoritativeClaimSnapshot,
  type ClaimSubmissionPort,
} from "../../apps/merchant-mobile/src/claim-sync.js";

const hex = (value: string): string => value.repeat(64);

function claim(marker = "a"): StoredClaim {
  return createStoredClaim({
    credentialHash: hex(marker),
    sessionId: hex("1"),
    amount: "50",
    frames: [`frame-${marker}`],
  });
}

function snapshot(value: StoredClaim, status: AuthoritativeClaimSnapshot["status"] = "submitted"): AuthoritativeClaimSnapshot {
  return {
    confirmed: true,
    credentialHash: value.credentialHash,
    sessionId: value.sessionId,
    amount: value.amount,
    status,
    confirmedSlot: "42",
    transactionSignature: "chain-signature",
  };
}

function port(overrides: Partial<ClaimSubmissionPort> = {}): ClaimSubmissionPort {
  return {
    lookupConfirmedClaim: vi.fn(async () => null),
    submitClaim: vi.fn(async () => ({ transactionSignature: "submitted-signature" })),
    confirmTransaction: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("merchant reconnect claim queue", () => {
  it("does nothing while offline", async () => {
    const adapter = port();
    const result = await syncClaimQueue([claim()], false, adapter);

    expect(result).toMatchObject({ attempted: 0, confirmed: 0, failed: 0 });
    expect(adapter.lookupConfirmedClaim).not.toHaveBeenCalled();
    expect(adapter.submitClaim).not.toHaveBeenCalled();
  });

  it("adopts an already confirmed claim without submitting a duplicate", async () => {
    const local = claim();
    const adapter = port({ lookupConfirmedClaim: vi.fn(async () => snapshot(local, "valid")) });
    const updated = await syncStoredClaim(local, adapter);

    expect(updated.status).toBe("submitted");
    expect(updated.transactionSignature).toBe("chain-signature");
    expect(updated.lastConfirmedSlot).toBe("42");
    expect(adapter.submitClaim).not.toHaveBeenCalled();
  });

  it("marks success only after transaction confirmation and a matching confirmed account read", async () => {
    const local = claim();
    const lookup = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snapshot(local));
    const adapter = port({ lookupConfirmedClaim: lookup });
    const updated = await syncStoredClaim(local, adapter);

    expect(updated.status).toBe("submitted");
    expect(updated.submissionAttempts).toBe(1);
    expect(updated.lastSubmissionError).toBeNull();
    expect(adapter.submitClaim).toHaveBeenCalledOnce();
    expect(adapter.confirmTransaction).toHaveBeenCalledWith("submitted-signature");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("recovers an ambiguous network failure by looking up the hash before retrying", async () => {
    const local = claim();
    const lookup = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snapshot(local));
    const adapter = port({
      lookupConfirmedClaim: lookup,
      submitClaim: vi.fn(async () => { throw new Error("resposta RPC perdida"); }),
    });
    const updated = await syncStoredClaim(local, adapter);

    expect(updated.status).toBe("submitted");
    expect(updated.submissionAttempts).toBe(1);
    expect(updated.lastSubmissionError).toBeNull();
  });

  it("fails closed when authoritative fields do not match local durable evidence", async () => {
    const local = claim();
    const adapter = port({
      lookupConfirmedClaim: vi.fn(async () => ({ ...snapshot(local), amount: "51" })),
    });
    const updated = await syncStoredClaim(local, adapter);

    expect(updated.status).toBe("pending-submission");
    expect(updated.submissionAttempts).toBe(1);
    expect(updated.lastSubmissionError).toMatch(/valor.*divergente/i);
    expect(adapter.submitClaim).not.toHaveBeenCalled();
  });

  it("continues deterministic hash-ordered processing after an individual failure", async () => {
    const first = claim("a");
    const second = claim("b");
    const order: string[] = [];
    const adapter = port({
      lookupConfirmedClaim: vi.fn(async (current) => {
        order.push(current.credentialHash);
        if (current.credentialHash === first.credentialHash) throw new Error("RPC indisponível para a primeira prova");
        return snapshot(current, "settled");
      }),
    });
    const result = await syncClaimQueue([second, first], true, adapter);

    expect(order).toEqual([first.credentialHash, second.credentialHash]);
    expect(result).toMatchObject({ attempted: 2, confirmed: 1, failed: 1 });
    expect(result.claims.find((item) => item.credentialHash === first.credentialHash)?.status).toBe("pending-submission");
    expect(result.claims.find((item) => item.credentialHash === second.credentialHash)?.status).toBe("settled");
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyPayment } from "@ogp/offline-ledger";
import {
  allocateDeterministicCoverage,
  reconcileSession,
  type ReconciledClaim,
} from "@ogp/reconciliation";
import type { PaymentCredential } from "@ogp/shared-types";
import { makeFixture, type ProtocolFixture } from "../crypto/fixture.js";

const U64_MAX = (1n << 64n) - 1n;
const filled = (value: number): Uint8Array => new Uint8Array(32).fill(value & 0xff);
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const deterministicSecrets = {
  walletSecret: filled(0x01),
  deviceSecret: filled(0x02),
  issuerSecret: filled(0x03),
};

interface PlannedPayment {
  readonly amount: number;
  readonly merchant: number;
}

interface PlannedBranch {
  readonly payments: readonly PlannedPayment[];
}

const paymentArbitrary = fc.record({
  amount: fc.integer({ min: 1, max: 400 }),
  merchant: fc.integer({ min: 0, max: 4 }),
});

const branchArbitrary = fc.record({
  payments: fc.array(paymentArbitrary, { minLength: 1, maxLength: 4 })
    .filter((payments) => payments.reduce((total, payment) => total + payment.amount, 0) <= 1_000),
});

const graphScenarioArbitrary = fc.record({
  branches: fc.array(branchArbitrary, { minLength: 1, maxLength: 6 }),
  orderSeed: fc.integer({ min: 0, max: 0x7fff_ffff }),
  replayCount: fc.integer({ min: 0, max: 3 }),
});

function parentOf(credential: PaymentCredential) {
  return {
    stateHash: credential.newStateHash,
    sequence: credential.sequence,
    remaining: credential.newRemaining,
  };
}

function buildCredentials(fixture: ProtocolFixture, branches: readonly PlannedBranch[]): PaymentCredential[] {
  const credentials: PaymentCredential[] = [];
  for (const [branchIndex, branch] of branches.entries()) {
    let parent = fixture.parent;
    for (const [depth, payment] of branch.payments.entries()) {
      const marker = branchIndex * 8 + depth;
      const credential = applyPayment(fixture.context, fixture.certificate, parent, {
        merchant: filled(0x20 + payment.merchant),
        merchantDeviceKey: filled(0x30 + payment.merchant),
        amount: BigInt(payment.amount),
        merchantChallenge: filled(0x60 + marker),
        createdAt: fixture.certificate.issuedAt + BigInt(100 + marker),
      }, fixture.deviceSecret);
      credentials.push(credential);
      parent = parentOf(credential);
    }
  }
  return credentials;
}

function reorder<T>(values: readonly T[], seed: number): T[] {
  return values
    .map((value, index) => ({ value, index, key: (Math.imul(index + 1, 0x45d9f3b) ^ seed) >>> 0 }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ value }) => value);
}

function reconcile(fixture: ProtocolFixture, credentials: readonly PaymentCredential[]) {
  return reconcileSession({
    context: fixture.context,
    sessionCertificate: fixture.certificate,
    deviceAuthorization: fixture.authorization,
    credentials,
  });
}

function allocationDigest(result: ReturnType<typeof allocateDeterministicCoverage>) {
  return {
    aggregate: result.aggregateOfflineExposure.toString(),
    coverage: result.coverage.toString(),
    total: result.totalPayout.toString(),
    insolvent: result.insolvent,
    allocations: result.allocations.map((allocation) => [
      hex(allocation.credentialHash),
      hex(allocation.merchant),
      allocation.amount.toString(),
      allocation.baseAllocation.toString(),
      allocation.dust.toString(),
      allocation.payout.toString(),
    ]),
  };
}

function syntheticClaim(index: number, amount: bigint, merchant = index % 5): ReconciledClaim {
  const credentialHash = new Uint8Array(32);
  new DataView(credentialHash.buffer).setUint32(28, index, false);
  return {
    classification: "VALID",
    edge: {
      credential: {} as PaymentCredential,
      credentialHash,
      parentStateHash: filled(0x01),
      childStateHash: filled(0x02 + index),
      sequence: index + 1,
      merchant: filled(0x20 + merchant),
      amount,
    },
  };
}

describe("H3 economic safety properties", () => {
  it("keeps liability capped across random authenticated DAGs, forks, merchants, replays, mutations, and arrival orders", () => {
    fc.assert(fc.property(graphScenarioArbitrary, ({ branches, orderSeed, replayCount }) => {
      const fixture = makeFixture(1n, 0x71, 0x91, deterministicSecrets);
      const validCredentials = buildCredentials(fixture, branches);
      const baselineReconciliation = reconcile(fixture, validCredentials);
      const baseline = allocateDeterministicCoverage(
        baselineReconciliation.eligibleClaims,
        fixture.certificate.collateralCoverageCap,
      );

      const target = validCredentials[orderSeed % validCredentials.length];
      if (target === undefined) throw new Error("generated graph must contain a credential");
      const amountMutation = { ...target, amount: target.amount + 1n };
      const merchantMutation = { ...target, merchant: filled(0xee) };
      const replays = Array.from({ length: replayCount }, () => target);
      const adversarialArrival = reorder([
        ...validCredentials,
        ...replays,
        amountMutation,
        merchantMutation,
      ], orderSeed);
      const adversarialReconciliation = reconcile(fixture, adversarialArrival);
      const adversarial = allocateDeterministicCoverage(
        adversarialReconciliation.eligibleClaims,
        fixture.certificate.collateralCoverageCap,
      );

      expect(allocationDigest(adversarial)).toEqual(allocationDigest(baseline));
      expect(adversarialReconciliation.invalidCredentials).toHaveLength(2);
      expect(adversarialReconciliation.duplicateCredentials).toHaveLength(replayCount);
      expect(adversarial.totalPayout).toBeLessThanOrEqual(fixture.certificate.collateralCoverageCap);
      expect(adversarial.totalPayout).toBe(adversarial.coverage);
      expect(adversarial.coverage).toBe(
        adversarial.aggregateOfflineExposure < fixture.certificate.collateralCoverageCap
          ? adversarial.aggregateOfflineExposure
          : fixture.certificate.collateralCoverageCap,
      );
      for (const allocation of adversarial.allocations) {
        expect(allocation.payout).toBeLessThanOrEqual(allocation.amount);
      }
    }), { numRuns: 128, seed: 0x0a6f_3301 });
  }, 30_000);

  it("allocates random dust exactly by unsigned credential hash and independently of input order", () => {
    const amountsArbitrary = fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 32 });
    fc.assert(fc.property(
      amountsArbitrary,
      fc.integer({ min: 0, max: 32_000_000 }),
      fc.integer({ min: 0, max: 0x7fff_ffff }),
      (amounts, cap, orderSeed) => {
        const claims = amounts.map((amount, index) => syntheticClaim(index + 1, BigInt(amount)));
        const forward = allocateDeterministicCoverage(claims, BigInt(cap));
        const shuffled = allocateDeterministicCoverage(reorder(claims, orderSeed), BigInt(cap));
        expect(allocationDigest(shuffled)).toEqual(allocationDigest(forward));
        expect(forward.totalPayout).toBe(forward.coverage);
        expect(forward.totalPayout).toBeLessThanOrEqual(BigInt(cap));
        expect(forward.dustUnits).toBe(forward.coverage - forward.baseAllocationTotal);
        for (const [index, allocation] of forward.allocations.entries()) {
          expect(allocation.dust).toBe(BigInt(index) < forward.dustUnits ? 1n : 0n);
        }
      },
    ), { numRuns: 2_048, seed: 0x0a6f_3302 });
  });

  it("allows aggregate branch exposure above one branch limit while keeping payout at the immutable cap", () => {
    const fixture = makeFixture(1n, 0x71, 0x91, deterministicSecrets);
    const branches = Array.from({ length: 4 }, (_, merchant): PlannedBranch => ({
      payments: [{ amount: 1_000, merchant }],
    }));
    const result = reconcile(fixture, buildCredentials(fixture, branches));
    const allocation = allocateDeterministicCoverage(result.eligibleClaims, fixture.certificate.collateralCoverageCap);

    expect(result.forks[0]?.branchCount).toBe(4);
    expect(allocation.aggregateOfflineExposure).toBe(4_000n);
    expect(fixture.certificate.branchSpendingLimit).toBe(1_000n);
    expect(allocation.totalPayout).toBe(3_000n);
    expect(allocation.totalPayout).toBe(fixture.certificate.collateralCoverageCap);
    expect(allocation.insolvent).toBe(true);
    expect(new Set(allocation.allocations.map((entry) => hex(entry.merchant))).size).toBe(4);
  });

  it("handles u64 boundaries and rejects impossible allocation material", () => {
    const maximum = allocateDeterministicCoverage([syntheticClaim(1, U64_MAX)], U64_MAX);
    expect(maximum.totalPayout).toBe(U64_MAX);
    expect(maximum.allocations[0]?.payout).toBe(U64_MAX);

    expect(allocateDeterministicCoverage([], U64_MAX)).toMatchObject({
      aggregateOfflineExposure: 0n,
      coverage: 0n,
      totalPayout: 0n,
      insolvent: false,
    });
    expect(() => allocateDeterministicCoverage([syntheticClaim(1, U64_MAX), syntheticClaim(2, 1n)], U64_MAX))
      .toThrow("EXPOSURE_OVERFLOW");
    expect(() => allocateDeterministicCoverage([syntheticClaim(1, 0n)], 1n))
      .toThrow("CLAIM_AMOUNT_OUT_OF_RANGE");
    expect(() => allocateDeterministicCoverage([syntheticClaim(1, 1n)], -1n))
      .toThrow("COLLATERAL_COVERAGE_CAP_OUT_OF_RANGE");
    expect(() => allocateDeterministicCoverage([syntheticClaim(1, 1n)], U64_MAX + 1n))
      .toThrow("COLLATERAL_COVERAGE_CAP_OUT_OF_RANGE");
    expect(() => allocateDeterministicCoverage([syntheticClaim(1, 1n), syntheticClaim(1, 1n)], 2n))
      .toThrow("DUPLICATE_ALLOCATION_EDGE");
  });
});

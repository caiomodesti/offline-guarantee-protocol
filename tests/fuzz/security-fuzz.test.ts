import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeDeviceAuthorization,
  decodePaymentCredential,
  decodeSessionCertificate,
  encodeDeviceAuthorization,
  encodePaymentCredential,
  encodeSessionCertificate,
} from "@ogp/canonical-codec";
import { credentialHash } from "@ogp/credentials";
import { detectForks, type StateEdge } from "@ogp/offline-ledger";
import { allocateDeterministicCoverage, reconcileSession, type ReconciledClaim } from "@ogp/reconciliation";
import { OgpValidationError } from "@ogp/shared-types";
import { QRTransport } from "@ogp/transports";
import { createStoredClaim } from "../../apps/merchant-mobile/src/claim-history.js";
import { materializeStoredClaim } from "../../apps/merchant-mobile/src/claim-material.js";
import { makeFixture } from "../crypto/fixture.js";

const corpus = JSON.parse(readFileSync(new URL("../../fixtures/fuzz-regressions-v1.json", import.meta.url), "utf8")) as {
  campaigns: Record<string, { readonly seed: number; readonly numRuns: number }>;
};
const campaign = (name: string) => {
  const value = corpus.campaigns[name];
  if (value === undefined) throw new Error(`missing fuzz campaign ${name}`);
  return value;
};
const U64_MAX = (1n << 64n) - 1n;
const filled = (value: number): Uint8Array => new Uint8Array(32).fill(value & 0xff);
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const secrets = { walletSecret: filled(1), deviceSecret: filled(2), issuerSecret: filled(3) };

function mutateByte(value: Uint8Array, index: number, mask: number): Uint8Array {
  const result = value.slice();
  result[index % result.length] = (result[index % result.length] ?? 0) ^ (mask || 1);
  return result;
}

function flipText(value: string): string {
  if (value.length === 0) return "a";
  const last = value.at(-1) ?? "a";
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

function syntheticClaim(index: number, amount: bigint): ReconciledClaim {
  const hash = new Uint8Array(32);
  new DataView(hash.buffer).setUint32(28, index, false);
  return {
    classification: "VALID",
    edge: {
      credential: {} as ReconciledClaim["edge"]["credential"],
      credentialHash: hash,
      parentStateHash: filled(0x10),
      childStateHash: filled(index),
      sequence: index,
      merchant: filled(0x20 + index),
      amount,
    },
  };
}

describe("H4 reproducible security fuzzing", () => {
  it("fuzzes canonical decoders without accepting non-round-trippable bytes", () => {
    const fixture = makeFixture(50n, 0x71, 0x91, secrets);
    const codecs = [
      { encoded: encodePaymentCredential(fixture.credential), decode: decodePaymentCredential, encode: encodePaymentCredential },
      { encoded: encodeDeviceAuthorization(fixture.authorization), decode: decodeDeviceAuthorization, encode: encodeDeviceAuthorization },
      { encoded: encodeSessionCertificate(fixture.certificate), decode: decodeSessionCertificate, encode: encodeSessionCertificate },
    ] as const;
    const config = campaign("canonicalDecoders");

    fc.assert(fc.property(
      fc.integer({ min: 0, max: codecs.length - 1 }),
      fc.integer({ min: 0, max: 553 }),
      fc.integer({ min: 1, max: 255 }),
      (codecIndex, byteIndex, mask) => {
        const codec = codecs[codecIndex];
        if (codec === undefined) throw new Error("codec index out of range");
        const input = mutateByte(codec.encoded, byteIndex, mask);
        try {
          const decoded = codec.decode(input as never);
          expect(codec.encode(decoded as never)).toEqual(input);
        } catch (error) {
          expect(error).toBeInstanceOf(OgpValidationError);
        }
      },
    ), config);

    for (const input of [new Uint8Array(), new Uint8Array(553), new Uint8Array(555)]) {
      expect(() => decodeSessionCertificate(input)).toThrowError();
    }
  });

  it("fuzzes stored claim material and never trusts editable metadata", () => {
    const fixture = makeFixture(50n, 0x71, 0x91, secrets);
    const frames = [...new QRTransport().sendCredential({
      sessionCertificate: fixture.certificate,
      deviceAuthorization: fixture.authorization,
      credentials: [fixture.credential],
    })];
    const claim = createStoredClaim({
      credentialHash: hex(credentialHash(fixture.credential)),
      sessionId: hex(fixture.credential.sessionId),
      amount: fixture.credential.amount.toString(),
      frames,
    });
    const trust = {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      trustedCertificateIssuer: fixture.context.trustedCertificateIssuer,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
    };
    const config = campaign("claimMaterial");

    fc.assert(fc.property(
      fc.constantFrom("amount", "hash", "session", "frame", "merchant", "device", "program", "issuer"),
      fc.integer({ min: 1, max: 255 }),
      (target, marker) => {
        const changedClaim = target === "amount" ? { ...claim, amount: String(50 + marker) }
          : target === "hash" ? { ...claim, credentialHash: flipText(claim.credentialHash) }
            : target === "session" ? { ...claim, sessionId: flipText(claim.sessionId) }
              : target === "frame" ? { ...claim, frames: [flipText(frames[0] ?? ""), ...frames.slice(1)] }
                : claim;
        const changedTrust = target === "merchant" ? { ...trust, merchant: mutateByte(trust.merchant, 0, marker) }
          : target === "device" ? { ...trust, merchantDeviceKey: mutateByte(trust.merchantDeviceKey, 0, marker) }
            : target === "program" ? { ...trust, programId: mutateByte(trust.programId, 0, marker) }
              : target === "issuer" ? { ...trust, trustedCertificateIssuer: mutateByte(trust.trustedCertificateIssuer, 0, marker) }
                : trust;
        expect(() => materializeStoredClaim(changedClaim, changedTrust)).toThrowError();
      },
    ), config);
  }, 30_000);

  it("fuzzes formal fork grouping and adversarial reconciliation mutations", () => {
    const config = campaign("graphAndReconciliation");
    const edgeArbitrary = fc.record({
      parent: fc.integer({ min: 0, max: 7 }),
      sequence: fc.integer({ min: 1, max: 8 }),
      child: fc.integer({ min: 0, max: 15 }),
    });
    fc.assert(fc.property(fc.array(edgeArbitrary, { maxLength: 64 }), (entries) => {
      const edges = entries.map((entry, index): StateEdge => ({
        credential: {} as StateEdge["credential"],
        credentialHash: filled(index + 1),
        parentStateHash: filled(entry.parent),
        childStateHash: filled(entry.child),
        sequence: entry.sequence,
        merchant: filled(0x40 + index),
        amount: 1n,
      }));
      const expected = new Map<string, Set<number>>();
      for (const entry of entries) {
        const key = `${entry.parent}:${entry.sequence}`;
        const children = expected.get(key) ?? new Set<number>();
        children.add(entry.child);
        expected.set(key, children);
      }
      const expectedForkSizes = [...expected.values()].filter((children) => children.size > 1).map((children) => children.size).sort((a, b) => a - b);
      const actualForkSizes = detectForks({ sessionId: filled(0xaa), edges }).map((fork) => fork.branchCount).sort((a, b) => a - b);
      expect(actualForkSizes).toEqual(expectedForkSizes);
    }), config);

    const fixture = makeFixture(50n, 0x71, 0x91, secrets);
    fc.assert(fc.property(
      fc.constantFrom("amount", "merchant", "signature", "parent", "child", "sequence"),
      fc.integer({ min: 1, max: 255 }),
      (target, marker) => {
        const valid = fixture.credential;
        const mutated = target === "amount" ? { ...valid, amount: valid.amount + BigInt(marker) }
          : target === "merchant" ? { ...valid, merchant: mutateByte(valid.merchant, 0, marker) }
            : target === "signature" ? { ...valid, payerSignature: mutateByte(valid.payerSignature, 0, marker) }
              : target === "parent" ? { ...valid, previousStateHash: mutateByte(valid.previousStateHash, 0, marker) }
                : target === "child" ? { ...valid, newStateHash: mutateByte(valid.newStateHash, 0, marker) }
                  : { ...valid, sequence: valid.sequence + marker };
        const result = reconcileSession({
          context: fixture.context,
          sessionCertificate: fixture.certificate,
          deviceAuthorization: fixture.authorization,
          credentials: [valid, mutated],
        });
        expect(result.eligibleClaims).toHaveLength(1);
        expect(result.aggregateOfflineExposure).toBe(valid.amount);
      },
    ), { ...config, numRuns: 512 });
  }, 30_000);

  it("fuzzes allocation arithmetic over and beyond u64 boundaries", () => {
    const config = campaign("arithmetic");
    fc.assert(fc.property(
      fc.array(fc.bigInt({ min: -1n, max: U64_MAX + 1n }), { maxLength: 16 }),
      fc.bigInt({ min: -1n, max: U64_MAX + 1n }),
      (amounts, cap) => {
        let exposure = 0n;
        const valid = cap >= 0n && cap <= U64_MAX && amounts.every((amount) => {
          if (amount <= 0n || amount > U64_MAX) return false;
          exposure += amount;
          return exposure <= U64_MAX;
        });
        try {
          const result = allocateDeterministicCoverage(amounts.map((amount, index) => syntheticClaim(index + 1, amount)), cap);
          expect(valid).toBe(true);
          expect(result.totalPayout).toBe(result.coverage);
          expect(result.totalPayout).toBeLessThanOrEqual(cap);
          expect(result.aggregateOfflineExposure).toBeLessThanOrEqual(U64_MAX);
          expect(result.allocations.every((entry) => entry.payout <= entry.amount)).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(valid).toBe(false);
        }
      },
    ), config);
  });

  it("fuzzes the QR frame parser and replays minimized malformed inputs", () => {
    const transport = new QRTransport();
    const config = campaign("qrFrameParser");
    fc.assert(fc.property(fc.string({ maxLength: 2_048 }), (raw) => {
      try {
        const receipt = transport.receiveReceipt([raw]);
        expect(receipt.credentialHash).toHaveLength(32);
        expect(receipt.merchantChallenge).toHaveLength(32);
      } catch (error) {
        expect(error).toBeInstanceOf(OgpValidationError);
      }
    }), config);

    for (const raw of ["", "OGPQR.2..0.1."]) {
      expect(() => transport.receiveReceipt([raw])).toThrowError();
    }
  });
});

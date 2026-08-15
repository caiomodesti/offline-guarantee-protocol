import { describe, expect, it } from "vitest";
import { credentialHash } from "@ogp/credentials";
import { QRTransport } from "@ogp/transports";
import { createStoredClaim, type StoredClaim } from "../../apps/merchant-mobile/src/claim-history.js";
import { materializeStoredClaim } from "../../apps/merchant-mobile/src/claim-material.js";
import { makeFixture } from "../crypto/fixture.js";

const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

function storedFixture(): { readonly claim: StoredClaim; readonly fixture: ReturnType<typeof makeFixture> } {
  const fixture = makeFixture(50n);
  const frames = new QRTransport().sendCredential({
    sessionCertificate: fixture.certificate,
    deviceAuthorization: fixture.authorization,
    credentials: [fixture.credential],
  });
  return {
    fixture,
    claim: createStoredClaim({
      credentialHash: hex(credentialHash(fixture.credential)),
      sessionId: hex(fixture.credential.sessionId),
      amount: fixture.credential.amount.toString(),
      frames,
    }),
  };
}

describe("merchant durable claim material", () => {
  it("revalidates stored QR evidence and derives exact submit_claim bytes", () => {
    const { claim, fixture } = storedFixture();
    const material = materializeStoredClaim(claim, {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      trustedCertificateIssuer: fixture.context.trustedCertificateIssuer,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
    });

    expect(material.payload).toHaveLength(410);
    expect(material.payerSignature).toHaveLength(64);
    expect(hex(material.credentialHash)).toBe(claim.credentialHash);
  });

  it("rejects editable metadata or merchant substitution", () => {
    const { claim, fixture } = storedFixture();
    const trust = {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      trustedCertificateIssuer: fixture.context.trustedCertificateIssuer,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
    };

    expect(() => materializeStoredClaim({ ...claim, amount: "51" }, trust)).toThrowError(/valor.*divergente/i);
    expect(() => materializeStoredClaim(claim, { ...trust, merchant: new Uint8Array(32).fill(0x44) })).toThrowError(/merchant.*divergente/i);
  });
});

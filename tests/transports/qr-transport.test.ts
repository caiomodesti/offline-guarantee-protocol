import { describe, expect, it } from "vitest";
import { credentialHash } from "@ogp/credentials";
import { OgpValidationError } from "@ogp/shared-types";
import { QRTransport, validateMerchantResponse } from "@ogp/transports";
import { makeFixture } from "../crypto/fixture.js";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected action to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(OgpValidationError);
    expect((error as OgpValidationError).code).toBe(code);
  }
}

describe("QRTransport", () => {
  it("round-trips a domain-bound merchant challenge", () => {
    const fixture = makeFixture();
    const transport = new QRTransport(64);
    const challenge = {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
      amount: fixture.credential.amount,
      challenge: fixture.credential.merchantChallenge,
    };
    const frames = transport.sendChallenge(challenge);
    expect(frames.length).toBeGreaterThan(1);
    expect(transport.receiveChallenge([...frames].reverse())).toEqual(challenge);
  });

  it("fragments and reassembles a portable proof bundle out of order", () => {
    const fixture = makeFixture();
    const transport = new QRTransport(128);
    const bundle = { sessionCertificate: fixture.certificate, deviceAuthorization: fixture.authorization, credentials: [fixture.credential] };
    const frames = transport.sendCredential(bundle);
    expect(frames.length).toBeGreaterThan(5);
    const decoded = transport.receiveCredential([...frames].reverse());
    expect(decoded).toEqual(bundle);
  });

  it("accepts an identical duplicate frame without changing the result", () => {
    const fixture = makeFixture();
    const transport = new QRTransport(128);
    const bundle = { sessionCertificate: fixture.certificate, deviceAuthorization: fixture.authorization, credentials: [fixture.credential] };
    const frames = [...transport.sendCredential(bundle)];
    frames.push(frames[0]!);
    expect(transport.receiveCredential(frames)).toEqual(bundle);
  });

  it("rejects incomplete, mixed, wrong-kind and tampered transfers", () => {
    const first = makeFixture(100n, 0x31, 0x41);
    const second = makeFixture(200n, 0x51, 0x61);
    const transport = new QRTransport(128);
    const firstFrames = [...transport.sendCredential({ sessionCertificate: first.certificate, deviceAuthorization: first.authorization, credentials: [first.credential] })];
    const secondFrames = [...transport.sendCredential({ sessionCertificate: second.certificate, deviceAuthorization: second.authorization, credentials: [second.credential] })];
    expectCode(() => transport.receiveCredential(firstFrames.slice(1)), "INCOMPLETE_QR_TRANSFER");
    expectCode(() => transport.receiveCredential([firstFrames[0]!, secondFrames[1]!]), "MIXED_QR_TRANSFER");
    expectCode(() => transport.receiveChallenge(firstFrames), "INVALID_QR_FRAME");
    const fields = firstFrames[0]!.split(".");
    fields[5] = `${fields[5]!.slice(0, -1)}${fields[5]!.endsWith("A") ? "B" : "A"}`;
    firstFrames[0] = fields.join(".");
    expectCode(() => transport.receiveCredential(firstFrames), "QR_INTEGRITY_FAILURE");
  });

  it("round-trips a transport-only receipt and identifies it as non-economic", () => {
    const fixture = makeFixture();
    const transport = new QRTransport();
    const receipt = { credentialHash: credentialHash(fixture.credential), merchantChallenge: fixture.credential.merchantChallenge };
    expect(transport.receiveReceipt(transport.sendReceipt(receipt))).toEqual(receipt);
  });

  it("rejects zero challenges and non-positive amounts", () => {
    const fixture = makeFixture();
    const transport = new QRTransport();
    const base = {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
      amount: 1n,
      challenge: fixture.credential.merchantChallenge,
    };
    expectCode(() => transport.sendChallenge({ ...base, amount: 0n }), "INVALID_AMOUNT");
    expectCode(() => transport.sendChallenge({ ...base, challenge: new Uint8Array(32) }), "INVALID_CHALLENGE");
  });

  it("accepts only the proof that answers the outstanding merchant request", () => {
    const fixture = makeFixture();
    const environment = {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      trustedCertificateIssuer: fixture.context.trustedCertificateIssuer,
    };
    const challenge = {
      networkId: fixture.context.networkId,
      clusterGenesisHash: fixture.context.clusterGenesisHash,
      programId: fixture.context.programId,
      merchant: fixture.credential.merchant,
      merchantDeviceKey: fixture.credential.merchantDeviceKey,
      amount: fixture.credential.amount,
      challenge: fixture.credential.merchantChallenge,
    };
    const bundle = { sessionCertificate: fixture.certificate, deviceAuthorization: fixture.authorization, credentials: [fixture.credential] };
    expect(validateMerchantResponse(environment, challenge, bundle).credential).toEqual(fixture.credential);
    expectCode(() => validateMerchantResponse(environment, { ...challenge, merchant: new Uint8Array(32).fill(0x44) }, bundle), "MERCHANT_MISMATCH");
    expectCode(() => validateMerchantResponse(environment, { ...challenge, amount: challenge.amount + 1n }, bundle), "CHALLENGE_MISMATCH");
    expectCode(() => validateMerchantResponse(environment, { ...challenge, challenge: new Uint8Array(32).fill(0x45) }, bundle), "CHALLENGE_MISMATCH");
    expectCode(() => validateMerchantResponse({ ...environment, trustedCertificateIssuer: new Uint8Array(32).fill(0x46) }, challenge, bundle), "UNTRUSTED_ISSUER");
    expectCode(() => validateMerchantResponse({ ...environment, programId: new Uint8Array(32).fill(0x47) }, challenge, bundle), "DOMAIN_MISMATCH");
  });
});

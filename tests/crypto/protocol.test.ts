import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { credentialProofBundleEncodedLength, decodeDeviceAuthorization, decodePaymentCredential, decodeSessionCertificate, encodeCredentialProofBundle, encodeDeviceAuthorization, encodeDeviceAuthorizationPayload, encodeGenesisState, encodePaymentCredential, encodePaymentCredentialPayload, encodePaymentState, encodeSessionCertificate, encodeSessionCertificatePayload, ENCODED_LENGTHS } from "@ogp/canonical-codec";
import { generateChallenge, hashSha256, verifyEd25519 } from "@ogp/crypto";
import { ObjectType, OgpValidationError, equalBytes } from "@ogp/shared-types";
import { createDomain, createPaymentCredential, credentialHash, detectAuthenticatedFork, deviceAuthorizationHash, paymentStateHash, signDeviceAuthorization, signSessionCertificate, validateCertificateChain, validateCredentialProofBundle, validatePaymentCredential, verifyCredentialSignature } from "@ogp/credentials";
import { makeFixture } from "./fixture.js";

describe("canonical codec and signatures", () => {
  it("emits the frozen fixed lengths and round-trips exact wrappers", () => {
    const fixture = makeFixture();
    expect(encodeDeviceAuthorizationPayload(fixture.authorization)).toHaveLength(ENCODED_LENGTHS.deviceAuthorizationPayload);
    expect(encodeSessionCertificatePayload(fixture.certificate)).toHaveLength(ENCODED_LENGTHS.sessionCertificatePayload);
    expect(encodeGenesisState(fixture.genesis)).toHaveLength(ENCODED_LENGTHS.genesisState);
    expect(encodePaymentCredentialPayload(fixture.credential)).toHaveLength(ENCODED_LENGTHS.paymentCredentialPayload);
    expect(encodeDeviceAuthorization(fixture.authorization)).toEqual(encodeDeviceAuthorization(decodeDeviceAuthorization(encodeDeviceAuthorization(fixture.authorization))));
    expect(encodeSessionCertificate(fixture.certificate)).toEqual(encodeSessionCertificate(decodeSessionCertificate(encodeSessionCertificate(fixture.certificate))));
    expect(encodePaymentCredential(fixture.credential)).toEqual(encodePaymentCredential(decodePaymentCredential(encodePaymentCredential(fixture.credential))));
  });

  it("rejects truncation and trailing bytes", () => {
    const bytes = encodePaymentCredential(makeFixture().credential);
    expect(() => decodePaymentCredential(bytes.slice(0, -1))).toThrowError(OgpValidationError);
    const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes); trailing[bytes.length] = 1;
    expect(() => decodePaymentCredential(trailing)).toThrowError(OgpValidationError);
  });

  it("invalidates the signature for every one-byte payload mutation", () => {
    const { credential } = makeFixture();
    const payload = encodePaymentCredentialPayload(credential);
    for (let index = 0; index < payload.length; index += 1) {
      const changed = payload.slice(); changed[index] = (changed[index] ?? 0) ^ 1;
      expect(verifyEd25519(credential.payerSignature, changed, credential.payerDeviceKey), `byte ${index}`).toBe(false);
    }
  });

  it("binds environment, program, version, object type, and session", () => {
    const fixture = makeFixture();
    const variants = [
      { ...fixture.credential, domain: { ...fixture.credential.domain, networkId: 0 } },
      { ...fixture.credential, domain: { ...fixture.credential.domain, clusterGenesisHash: new Uint8Array(32).fill(2) } },
      { ...fixture.credential, domain: { ...fixture.credential.domain, programId: new Uint8Array(32).fill(3) } },
      { ...fixture.credential, domain: { ...fixture.credential.domain, sessionId: new Uint8Array(32).fill(4) } },
    ];
    for (const variant of variants) expect(() => validatePaymentCredential(fixture.context, fixture.certificate, fixture.parent, variant)).toThrowError(/domain|session/i);
    expect(() => encodePaymentCredentialPayload({ ...fixture.credential, domain: { ...fixture.credential.domain, protocolVersion: 2 } })).toThrowError(/version/i);
    expect(() => encodePaymentCredentialPayload({ ...fixture.credential, domain: { ...fixture.credential.domain, objectType: ObjectType.GenesisState } })).toThrowError(/object type/i);
  });

  it("uses CSPRNG challenges and forbids all-zero challenges", () => {
    for (let index = 0; index < 16; index += 1) expect(generateChallenge()).toSatisfy((value: Uint8Array) => value.length === 32 && value.some((byte) => byte !== 0));
    const fixture = makeFixture();
    expect(() => createPaymentCredential(fixture.context, fixture.certificate, fixture.parent, { merchant: new Uint8Array(32).fill(5), merchantDeviceKey: new Uint8Array(32).fill(6), amount: 1n, merchantChallenge: new Uint8Array(32), createdAt: fixture.certificate.issuedAt }, fixture.deviceSecret)).toThrowError(/zero challenge/i);
  });
});

describe("certificate chain and deterministic transitions", () => {
  it("validates wallet authorization, issuer certificate, genesis, and branch reachability", () => {
    const fixture = makeFixture();
    expect(() => validateCertificateChain(fixture.context, fixture.certificate, fixture.authorization)).not.toThrow();
    const tip = validateCredentialProofBundle(fixture.context, { sessionCertificate: fixture.certificate, deviceAuthorization: fixture.authorization, credentials: [fixture.credential] });
    expect(tip.sequence).toBe(1); expect(tip.remaining).toBe(600n); expect(equalBytes(tip.stateHash, fixture.credential.newStateHash)).toBe(true);
  });

  it("rejects a valid self-signed certificate outside the configured trust root", () => {
    const fixture = makeFixture();
    const untrustedContext = { ...fixture.context, trustedCertificateIssuer: new Uint8Array(32).fill(0xee) };
    expect(() => validateCertificateChain(untrustedContext, fixture.certificate, fixture.authorization)).toThrowError(/trust root/i);
    expect(() => validatePaymentCredential(untrustedContext, fixture.certificate, fixture.parent, fixture.credential)).toThrowError(/trust root/i);
  });

  it("requires the MVP coverage cap to equal locked collateral", () => {
    const fixture = makeFixture();
    const authorization = signDeviceAuthorization({ ...fixture.authorization, collateralCoverageCap: 2_999n }, fixture.walletSecret);
    const certificate = signSessionCertificate({ ...fixture.certificate, collateralCoverageCap: 2_999n, deviceAuthorizationHash: deviceAuthorizationHash(authorization) }, fixture.issuerSecret);
    expect(() => validateCertificateChain(fixture.context, certificate, authorization)).toThrowError(/economic constraints/i);
  });

  it("does checked integer transitions for every admissible amount", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1_000 }), (amount) => {
      const fixture = makeFixture(BigInt(amount));
      validatePaymentCredential(fixture.context, fixture.certificate, fixture.parent, fixture.credential);
      return fixture.credential.newRemaining === 1_000n - BigInt(amount);
    }), { numRuns: 64 });
  });

  it("accepts exactly 32 reachable credentials and fixes the maximum bundle at 16,096 bytes", () => {
    const fixture = makeFixture(1n, 0x51, 0x61);
    const credentials = [fixture.credential];
    let parent = { stateHash: fixture.credential.newStateHash, sequence: 1, remaining: fixture.credential.newRemaining };
    for (let sequence = 2; sequence <= 32; sequence += 1) {
      const credential = createPaymentCredential(fixture.context, fixture.certificate, parent, { merchant: new Uint8Array(32).fill(0x51), merchantDeviceKey: new Uint8Array(32).fill(0x52), amount: 1n, merchantChallenge: new Uint8Array(32).fill(sequence), createdAt: fixture.certificate.issuedAt + BigInt(sequence) }, fixture.deviceSecret);
      credentials.push(credential); parent = { stateHash: credential.newStateHash, sequence, remaining: credential.newRemaining };
    }
    const bundle = { sessionCertificate: fixture.certificate, deviceAuthorization: fixture.authorization, credentials };
    expect(validateCredentialProofBundle(fixture.context, bundle).sequence).toBe(32);
    expect(credentialProofBundleEncodedLength(32)).toBe(16_096);
    expect(encodeCredentialProofBundle(bundle)).toHaveLength(16_096);
    expect(() => createPaymentCredential(fixture.context, fixture.certificate, parent, { merchant: new Uint8Array(32).fill(0x51), merchantDeviceKey: new Uint8Array(32).fill(0x52), amount: 1n, merchantChallenge: new Uint8Array(32).fill(33), createdAt: fixture.certificate.issuedAt + 33n }, fixture.deviceSecret)).toThrowError(/depth/i);
  });

  it("rejects wrong signature, wrong merchant economics, and arithmetic mutation", () => {
    const fixture = makeFixture();
    const signature = fixture.credential.payerSignature.slice(); signature[0] = (signature[0] ?? 0) ^ 1;
    expect(verifyCredentialSignature({ ...fixture.credential, payerSignature: signature })).toBe(false);
    expect(() => validatePaymentCredential(fixture.context, fixture.certificate, fixture.parent, { ...fixture.credential, payerSignature: signature })).toThrowError(/signature/i);
    expect(() => validatePaymentCredential(fixture.context, fixture.certificate, fixture.parent, { ...fixture.credential, newRemaining: fixture.credential.newRemaining + 1n })).toThrowError(/arithmetic/i);
  });

  it("derives exactly the signed PaymentState hash", () => {
    const fixture = makeFixture();
    const state = { domain: createDomain(fixture.context, ObjectType.PaymentState), previousStateHash: fixture.credential.previousStateHash, sequence: fixture.credential.sequence, merchant: fixture.credential.merchant, amount: fixture.credential.amount, merchantChallenge: fixture.credential.merchantChallenge, previousRemaining: fixture.credential.previousRemaining, newRemaining: fixture.credential.newRemaining };
    expect(encodePaymentState(state)).toHaveLength(ENCODED_LENGTHS.paymentState);
    expect(equalBytes(paymentStateHash(state), fixture.credential.newStateHash)).toBe(true);
    expect(credentialHash(fixture.credential)).toEqual(hashSha256(encodePaymentCredential(fixture.credential)));
  });
});

describe("formal fork detector", () => {
  it("distinguishes a normal branch and an identical replay", () => {
    const fixture = makeFixture();
    const one = detectAuthenticatedFork(fixture.context, fixture.certificate, fixture.parent, [fixture.credential]);
    const replay = detectAuthenticatedFork(fixture.context, fixture.certificate, fixture.parent, [fixture.credential, fixture.credential]);
    expect(one).toMatchObject({ authenticatedFork: false, branchCount: 1 });
    expect(replay).toMatchObject({ authenticatedFork: false, branchCount: 1 });
  });

  it("detects simple and triple forks with the same parent and sequence", () => {
    const a = makeFixture(100n, 0x31, 0x41);
    const makeSibling = (amount: bigint, merchant: number, challenge: number) => createPaymentCredential(a.context, a.certificate, a.parent, { merchant: new Uint8Array(32).fill(merchant), merchantDeviceKey: new Uint8Array(32).fill(merchant + 1), amount, merchantChallenge: new Uint8Array(32).fill(challenge), createdAt: a.certificate.issuedAt + 200n }, a.deviceSecret);
    const b = makeSibling(200n, 0x32, 0x42); const c = makeSibling(300n, 0x33, 0x43);
    expect(detectAuthenticatedFork(a.context, a.certificate, a.parent, [a.credential, b])).toMatchObject({ authenticatedFork: true, branchCount: 2 });
    expect(detectAuthenticatedFork(a.context, a.certificate, a.parent, [a.credential, b, c])).toMatchObject({ authenticatedFork: true, branchCount: 3 });
  });

  it("excludes an invalid credential from the child set", () => {
    const fixture = makeFixture();
    const invalidSignature = fixture.credential.payerSignature.slice(); invalidSignature[0] = (invalidSignature[0] ?? 0) ^ 1;
    const result = detectAuthenticatedFork(fixture.context, fixture.certificate, fixture.parent, [fixture.credential, { ...fixture.credential, newStateHash: new Uint8Array(32).fill(9), payerSignature: invalidSignature }]);
    expect(result).toMatchObject({ authenticatedFork: false, branchCount: 1 });
    expect(result.rejected).toHaveLength(1);
  });
});

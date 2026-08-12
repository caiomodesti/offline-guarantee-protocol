import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { encodeDeviceAuthorization, encodeDeviceAuthorizationPayload, encodeGenesisState, encodeIdentityAttestation, encodeIdentityAttestationPayload, encodePaymentCredential, encodePaymentCredentialPayload, encodePaymentState, encodeSessionCertificate, encodeSessionCertificatePayload, ENCODED_LENGTHS } from "@ogp/canonical-codec";
import { hashSha256, signEd25519, verifyEd25519 } from "@ogp/crypto";
import { AttestationStatus, NetworkId, ObjectType, equalBytes, type IdentityAttestation, type IdentityAttestationPayload } from "@ogp/shared-types";
import { createDomain, credentialHash, deviceAuthorizationHash, paymentStateHash, sessionCertificateHash } from "@ogp/credentials";
import { makeFixture } from "../tests/crypto/fixture.js";

const fixturePath = resolve("fixtures/golden-v1.json");
const hex = (value: Uint8Array): string => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string): Uint8Array => Uint8Array.from(value.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);

interface Vector { readonly payloadHex: string; readonly signedHex?: string; readonly publicKeyHex?: string; readonly signatureHex?: string; readonly hashHex: string; readonly encodedLength: number; readonly signedLength?: number }
interface GoldenFixture { readonly format: "ogp-golden-v1"; readonly protocolVersion: 1; readonly schemaVersion: 1; readonly vectors: Record<string, Vector> }

function makeGoldenFixture(): GoldenFixture {
  const fixture = makeFixture();
  const paymentState = { domain: createDomain(fixture.context, ObjectType.PaymentState), previousStateHash: fixture.credential.previousStateHash, sequence: fixture.credential.sequence, merchant: fixture.credential.merchant, amount: fixture.credential.amount, merchantChallenge: fixture.credential.merchantChallenge, previousRemaining: fixture.credential.previousRemaining, newRemaining: fixture.credential.newRemaining };
  const globalIdentityContext = { ...fixture.context, networkId: NetworkId.Devnet, sessionId: new Uint8Array(32) };
  const identityPayload: IdentityAttestationPayload = { domain: createDomain(globalIdentityContext, ObjectType.IdentityAttestation), issuer: fixture.certificate.issuer, subjectWallet: fixture.certificate.owner, assuranceLevel: 1, issuedAt: fixture.certificate.issuedAt - 60n, expiresAt: fixture.certificate.claimSubmissionDeadline + 86_400n, attestationId: new Uint8Array(32).fill(0x5a), status: AttestationStatus.Active };
  const identity: IdentityAttestation = { ...identityPayload, issuerSignature: signEd25519(encodeIdentityAttestationPayload(identityPayload), fixture.issuerSecret) };
  const signed = (payload: Uint8Array, wrapper: Uint8Array, publicKey: Uint8Array, signature: Uint8Array, hash: Uint8Array): Vector => ({ payloadHex: hex(payload), signedHex: hex(wrapper), publicKeyHex: hex(publicKey), signatureHex: hex(signature), hashHex: hex(hash), encodedLength: payload.length, signedLength: wrapper.length });
  const hashed = (payload: Uint8Array, hash: Uint8Array): Vector => ({ payloadHex: hex(payload), hashHex: hex(hash), encodedLength: payload.length });
  return {
    format: "ogp-golden-v1", protocolVersion: 1, schemaVersion: 1,
    vectors: {
      deviceAuthorization: signed(encodeDeviceAuthorizationPayload(fixture.authorization), encodeDeviceAuthorization(fixture.authorization), fixture.authorization.owner, fixture.authorization.walletSignature, deviceAuthorizationHash(fixture.authorization)),
      sessionCertificate: signed(encodeSessionCertificatePayload(fixture.certificate), encodeSessionCertificate(fixture.certificate), fixture.certificate.issuer, fixture.certificate.issuerSignature, sessionCertificateHash(fixture.certificate)),
      genesisState: hashed(encodeGenesisState(fixture.genesis), fixture.certificate.genesisStateHash),
      paymentState: hashed(encodePaymentState(paymentState), paymentStateHash(paymentState)),
      paymentCredential: signed(encodePaymentCredentialPayload(fixture.credential), encodePaymentCredential(fixture.credential), fixture.credential.payerDeviceKey, fixture.credential.payerSignature, credentialHash(fixture.credential)),
      identityAttestation: signed(encodeIdentityAttestationPayload(identity), encodeIdentityAttestation(identity), identity.issuer, identity.issuerSignature, hashSha256(encodeIdentityAttestation(identity))),
    },
  };
}

async function loadOrCreate(refresh: boolean): Promise<GoldenFixture> {
  if (refresh || !existsSync(fixturePath)) {
    const fixture = makeGoldenFixture();
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    return fixture;
  }
  return JSON.parse(await readFile(fixturePath, "utf8")) as GoldenFixture;
}

function verifyFixture(fixture: GoldenFixture): void {
  if (fixture.format !== "ogp-golden-v1" || fixture.protocolVersion !== 1 || fixture.schemaVersion !== 1) throw new Error("unsupported fixture header");
  const expectedPayloadLengths: Record<string, number> = { deviceAuthorization: ENCODED_LENGTHS.deviceAuthorizationPayload, sessionCertificate: ENCODED_LENGTHS.sessionCertificatePayload, genesisState: ENCODED_LENGTHS.genesisState, paymentState: ENCODED_LENGTHS.paymentState, paymentCredential: ENCODED_LENGTHS.paymentCredentialPayload, identityAttestation: ENCODED_LENGTHS.identityAttestationPayload };
  for (const [name, vector] of Object.entries(fixture.vectors)) {
    const payload = bytes(vector.payloadHex);
    if (payload.length !== expectedPayloadLengths[name] || vector.encodedLength !== payload.length) throw new Error(`${name}: payload length mismatch`);
    const hashInput = vector.signedHex === undefined ? payload : bytes(vector.signedHex);
    if (!equalBytes(hashSha256(hashInput), bytes(vector.hashHex))) throw new Error(`${name}: SHA-256 mismatch`);
    if (vector.signatureHex !== undefined && vector.publicKeyHex !== undefined) {
      const signature = bytes(vector.signatureHex);
      if (!verifyEd25519(signature, payload, bytes(vector.publicKeyHex))) throw new Error(`${name}: Ed25519 signature mismatch`);
      if (vector.signedLength !== hashInput.length || !equalBytes(hashInput.slice(-64), signature)) throw new Error(`${name}: signed wrapper mismatch`);
    }
  }
}

const fixture = await loadOrCreate(process.argv.includes("--refresh"));
verifyFixture(fixture);
process.stdout.write(`verified ${Object.keys(fixture.vectors).length} OGP golden vectors at ${fixturePath}\n`);

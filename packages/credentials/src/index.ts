import {
  encodeDeviceAuthorization,
  encodeDeviceAuthorizationPayload,
  encodeGenesisState,
  encodeIdentityAttestation,
  encodeIdentityAttestationPayload,
  encodePaymentCredential,
  encodePaymentCredentialPayload,
  encodePaymentState,
  encodeSessionCertificate,
  encodeSessionCertificatePayload,
} from "@ogp/canonical-codec";
import { derivePublicKey, hashSha256, signEd25519, verifyEd25519 } from "@ogp/crypto";
import {
  MAX_BRANCH_DEPTH,
  ObjectType,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  SIGNATURE_LENGTH,
  assertBytes,
  assertI64,
  assertU32,
  assertU64,
  equalBytes,
  OgpValidationError,
  type DeviceAuthorization,
  type CredentialProofBundle,
  type DeviceAuthorizationPayload,
  type Domain,
  type DomainContext,
  type GenesisState,
  type IdentityAttestation,
  type IdentityAttestationPayload,
  type PaymentCredential,
  type PaymentCredentialPayload,
  type PaymentState,
  type ProtocolTrustContext,
  type SessionCertificate,
  type SessionCertificatePayload,
} from "@ogp/shared-types";

export interface ParentState {
  readonly stateHash: Uint8Array;
  readonly sequence: number;
  readonly remaining: bigint;
}

export interface PaymentRequest {
  readonly merchant: Uint8Array;
  readonly merchantDeviceKey: Uint8Array;
  readonly amount: bigint;
  readonly merchantChallenge: Uint8Array;
  readonly createdAt: bigint;
}

export interface ForkDetectionResult {
  readonly authenticatedFork: boolean;
  readonly branchCount: number;
  readonly validCredentials: readonly PaymentCredential[];
  readonly rejected: readonly { credential: PaymentCredential; reason: string }[];
}

export function createDomain(context: DomainContext, objectType: ObjectType): Domain {
  return { protocolName: PROTOCOL_NAME.slice(), protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION, objectType, networkId: context.networkId, clusterGenesisHash: context.clusterGenesisHash.slice(), programId: context.programId.slice(), sessionId: context.sessionId.slice() };
}

function assertSessionBinding(domain: Domain, sessionId: Uint8Array): void {
  if (!equalBytes(domain.sessionId, sessionId)) throw new OgpValidationError("SESSION_MISMATCH", "domain session and payload session differ");
}

function assertDomainContext(domain: Domain, context: DomainContext, expectedType: ObjectType): void {
  if (domain.objectType !== expectedType || domain.networkId !== context.networkId || !equalBytes(domain.clusterGenesisHash, context.clusterGenesisHash) || !equalBytes(domain.programId, context.programId) || !equalBytes(domain.sessionId, context.sessionId)) {
    throw new OgpValidationError("DOMAIN_MISMATCH", "object domain differs from configured environment");
  }
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function signDeviceAuthorization(payload: DeviceAuthorizationPayload, walletSecretKey: Uint8Array): DeviceAuthorization {
  assertSessionBinding(payload.domain, payload.sessionId);
  return { ...payload, walletSignature: signEd25519(encodeDeviceAuthorizationPayload(payload), walletSecretKey) };
}

export function verifyDeviceAuthorization(value: DeviceAuthorization): boolean {
  try { assertSessionBinding(value.domain, value.sessionId); return verifyEd25519(value.walletSignature, encodeDeviceAuthorizationPayload(value), value.owner); } catch { return false; }
}

export function deviceAuthorizationHash(value: DeviceAuthorization): Uint8Array {
  return hashSha256(encodeDeviceAuthorization(value));
}

export function signSessionCertificate(payload: SessionCertificatePayload, issuerSecretKey: Uint8Array): SessionCertificate {
  assertSessionBinding(payload.domain, payload.sessionId);
  return { ...payload, issuerSignature: signEd25519(encodeSessionCertificatePayload(payload), issuerSecretKey) };
}

export function verifySessionCertificate(value: SessionCertificate): boolean {
  try { assertSessionBinding(value.domain, value.sessionId); return verifyEd25519(value.issuerSignature, encodeSessionCertificatePayload(value), value.issuer); } catch { return false; }
}

export function validateCertificateChain(context: ProtocolTrustContext, certificate: SessionCertificate, authorization: DeviceAuthorization): void {
  assertDomainContext(authorization.domain, context, ObjectType.DeviceAuthorization);
  assertDomainContext(certificate.domain, context, ObjectType.SessionCertificate);
  if (!verifyDeviceAuthorization(authorization)) throw new OgpValidationError("INVALID_DEVICE_AUTHORIZATION", "wallet authorization signature is invalid");
  if (!verifySessionCertificate(certificate)) throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate issuer signature is invalid");
  if (!equalBytes(certificate.issuer, context.trustedCertificateIssuer)) throw new OgpValidationError("UNTRUSTED_ISSUER", "certificate issuer is not the configured trust root");
  if (equalBytes(authorization.owner, authorization.devicePublicKey)) throw new OgpValidationError("INVALID_DEVICE_AUTHORIZATION", "wallet and per-session device keys must differ");
  if (!equalBytes(certificate.deviceAuthorizationHash, deviceAuthorizationHash(authorization))) throw new OgpValidationError("INVALID_DEVICE_AUTHORIZATION", "certificate authorization hash mismatch");
  const bytePairs = [[certificate.sessionId, authorization.sessionId], [certificate.owner, authorization.owner], [certificate.devicePublicKey, authorization.devicePublicKey], [certificate.vault, authorization.vault]] as const;
  if (bytePairs.some(([left, right]) => !equalBytes(left, right)) || certificate.branchSpendingLimit !== authorization.branchSpendingLimit || certificate.collateralCoverageCap !== authorization.collateralCoverageCap || certificate.maxBranchDepth !== authorization.maxBranchDepth || certificate.issuedAt !== authorization.issuedAt || certificate.expiresAt !== authorization.expiresAt) {
    throw new OgpValidationError("INVALID_DEVICE_AUTHORIZATION", "authorization and certificate immutable fields differ");
  }
  if (certificate.branchSpendingLimit <= 0n || certificate.collateralLocked <= 0n || certificate.collateralCoverageCap !== certificate.collateralLocked || certificate.branchSpendingLimit * 30_000n > certificate.collateralLocked * 10_000n) throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate economic constraints are invalid");
  if (certificate.maxBranchDepth !== MAX_BRANCH_DEPTH || certificate.expiresAt <= certificate.issuedAt || certificate.expiresAt - certificate.issuedAt > 3n * 60n * 60n || certificate.claimSubmissionDeadline !== certificate.expiresAt + 6n * 60n * 60n) throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate time or depth constraints are invalid");
}

export function sessionCertificateHash(value: SessionCertificate): Uint8Array {
  return hashSha256(encodeSessionCertificate(value));
}

export function createGenesisState(context: DomainContext, fields: Omit<GenesisState, "domain">): GenesisState {
  if (fields.initialRemaining !== fields.branchSpendingLimit) throw new OgpValidationError("INVALID_TRANSITION", "initial remaining must equal branch spending limit");
  if (fields.branchSpendingLimit <= 0n) throw new OgpValidationError("INVALID_AMOUNT", "branch spending limit must be positive");
  if (fields.maxBranchDepth !== MAX_BRANCH_DEPTH) throw new OgpValidationError("BRANCH_DEPTH_EXCEEDED", `MVP max branch depth must be ${MAX_BRANCH_DEPTH}`);
  if (fields.expiresAt <= fields.issuedAt) throw new OgpValidationError("SESSION_EXPIRED_METADATA", "expiry must be after issuance");
  return { domain: createDomain(context, ObjectType.GenesisState), ...fields };
}

export function genesisStateHash(value: GenesisState): Uint8Array { return hashSha256(encodeGenesisState(value)); }
export function paymentStateHash(value: PaymentState): Uint8Array { return hashSha256(encodePaymentState(value)); }

export function createPaymentCredential(
  context: ProtocolTrustContext,
  certificate: SessionCertificate,
  parent: ParentState,
  request: PaymentRequest,
  payerDeviceSecretKey: Uint8Array,
): PaymentCredential {
  assertDomainContext(certificate.domain, context, ObjectType.SessionCertificate);
  if (!verifySessionCertificate(certificate)) throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate signature is invalid");
  if (!equalBytes(certificate.issuer, context.trustedCertificateIssuer)) throw new OgpValidationError("UNTRUSTED_ISSUER", "certificate issuer is not the configured trust root");
  if (!equalBytes(context.sessionId, certificate.sessionId)) throw new OgpValidationError("SESSION_MISMATCH", "certificate belongs to another session");
  assertBytes(request.merchant, 32, "merchant"); assertBytes(request.merchantDeviceKey, 32, "merchantDeviceKey"); assertBytes(request.merchantChallenge, 32, "merchantChallenge");
  if (request.merchantChallenge.every((value) => value === 0)) throw new OgpValidationError("INVALID_CHALLENGE", "all-zero challenge is forbidden");
  if (equalBytes(certificate.owner, request.merchant)) throw new OgpValidationError("SELF_MERCHANT_FORBIDDEN", "payer wallet cannot be merchant");
  assertU64(request.amount, "amount"); if (request.amount === 0n || request.amount > parent.remaining) throw new OgpValidationError("INVALID_AMOUNT", "amount must be positive and no greater than remaining");
  assertU32(parent.sequence, "parent.sequence"); if (parent.sequence >= certificate.maxBranchDepth) throw new OgpValidationError("BRANCH_DEPTH_EXCEEDED", "next payment exceeds branch depth");
  assertI64(request.createdAt, "createdAt"); if (request.createdAt < certificate.issuedAt || request.createdAt > certificate.expiresAt) throw new OgpValidationError("SESSION_EXPIRED_METADATA", "createdAt is outside certificate range");
  const sequence = parent.sequence + 1;
  const newRemaining = parent.remaining - request.amount;
  const state: PaymentState = { domain: createDomain(context, ObjectType.PaymentState), previousStateHash: parent.stateHash, sequence, merchant: request.merchant, amount: request.amount, merchantChallenge: request.merchantChallenge, previousRemaining: parent.remaining, newRemaining };
  const payload: PaymentCredentialPayload = { domain: createDomain(context, ObjectType.PaymentCredential), sessionId: context.sessionId, sequence, payer: certificate.owner, payerDeviceKey: certificate.devicePublicKey, merchant: request.merchant, merchantDeviceKey: request.merchantDeviceKey, amount: request.amount, previousStateHash: parent.stateHash, newStateHash: paymentStateHash(state), previousRemaining: parent.remaining, newRemaining, merchantChallenge: request.merchantChallenge, createdAt: request.createdAt, sessionExpiresAt: certificate.expiresAt };
  if (!equalBytes(derivePublicKey(payerDeviceSecretKey), certificate.devicePublicKey)) throw new OgpValidationError("INVALID_DEVICE_AUTHORIZATION", "device secret key does not match certificate");
  return { ...payload, payerSignature: signEd25519(encodePaymentCredentialPayload(payload), payerDeviceSecretKey) };
}

export function validatePaymentCredential(context: ProtocolTrustContext, certificate: SessionCertificate, parent: ParentState, credential: PaymentCredential): void {
  assertDomainContext(certificate.domain, context, ObjectType.SessionCertificate);
  assertDomainContext(credential.domain, context, ObjectType.PaymentCredential);
  assertSessionBinding(credential.domain, credential.sessionId);
  if (!equalBytes(context.sessionId, credential.sessionId) || !equalBytes(certificate.sessionId, credential.sessionId)) throw new OgpValidationError("SESSION_MISMATCH", "credential belongs to another session");
  if (!verifySessionCertificate(certificate)) throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate signature is invalid");
  if (!equalBytes(certificate.issuer, context.trustedCertificateIssuer)) throw new OgpValidationError("UNTRUSTED_ISSUER", "certificate issuer is not the configured trust root");
  if (!equalBytes(credential.payer, certificate.owner) || !equalBytes(credential.payerDeviceKey, certificate.devicePublicKey)) throw new OgpValidationError("INVALID_DEVICE_AUTHORIZATION", "credential payer keys differ from certificate");
  if (equalBytes(credential.payer, credential.merchant)) throw new OgpValidationError("SELF_MERCHANT_FORBIDDEN", "payer wallet cannot be merchant");
  if (!equalBytes(credential.previousStateHash, parent.stateHash) || credential.sequence !== parent.sequence + 1) throw new OgpValidationError("INVALID_PARENT", "parent hash or sequence mismatch");
  if (credential.sequence > certificate.maxBranchDepth) throw new OgpValidationError("BRANCH_DEPTH_EXCEEDED", "credential exceeds branch depth");
  if (credential.amount === 0n || credential.amount > parent.remaining || credential.previousRemaining !== parent.remaining || credential.newRemaining !== parent.remaining - credential.amount) throw new OgpValidationError("INVALID_TRANSITION", "remaining-value arithmetic is invalid");
  if (credential.createdAt < certificate.issuedAt || credential.createdAt > certificate.expiresAt || credential.sessionExpiresAt !== certificate.expiresAt) throw new OgpValidationError("SESSION_EXPIRED_METADATA", "credential time metadata is inconsistent");
  if (credential.merchantChallenge.length !== 32 || credential.merchantChallenge.every((value) => value === 0)) throw new OgpValidationError("INVALID_CHALLENGE", "challenge is invalid");
  const state: PaymentState = { domain: createDomain(context, ObjectType.PaymentState), previousStateHash: credential.previousStateHash, sequence: credential.sequence, merchant: credential.merchant, amount: credential.amount, merchantChallenge: credential.merchantChallenge, previousRemaining: credential.previousRemaining, newRemaining: credential.newRemaining };
  if (!equalBytes(paymentStateHash(state), credential.newStateHash)) throw new OgpValidationError("INVALID_TRANSITION", "resulting state hash mismatch");
  if (!verifyEd25519(credential.payerSignature, encodePaymentCredentialPayload(credential), certificate.devicePublicKey)) throw new OgpValidationError("INVALID_SIGNATURE", "payer signature is invalid");
}

export function validateCredentialProofBundle(context: ProtocolTrustContext, bundle: CredentialProofBundle): ParentState {
  validateCertificateChain(context, bundle.sessionCertificate, bundle.deviceAuthorization);
  const certificate = bundle.sessionCertificate;
  if (bundle.credentials.length > certificate.maxBranchDepth) throw new OgpValidationError("BRANCH_DEPTH_EXCEEDED", "proof bundle is too deep");
  const genesis = createGenesisState(context, { owner: certificate.owner, devicePublicKey: certificate.devicePublicKey, branchSpendingLimit: certificate.branchSpendingLimit, maxBranchDepth: certificate.maxBranchDepth, initialRemaining: certificate.branchSpendingLimit, issuedAt: certificate.issuedAt, expiresAt: certificate.expiresAt });
  let parent: ParentState = { stateHash: genesisStateHash(genesis), sequence: 0, remaining: certificate.branchSpendingLimit };
  if (!equalBytes(parent.stateHash, certificate.genesisStateHash)) throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate genesis hash mismatch");
  for (const credential of bundle.credentials) {
    validatePaymentCredential(context, certificate, parent, credential);
    parent = { stateHash: credential.newStateHash, sequence: credential.sequence, remaining: credential.newRemaining };
  }
  return parent;
}

export function detectAuthenticatedFork(context: ProtocolTrustContext, certificate: SessionCertificate, parent: ParentState, candidates: readonly PaymentCredential[]): ForkDetectionResult {
  const validCredentials: PaymentCredential[] = [];
  const rejected: { credential: PaymentCredential; reason: string }[] = [];
  const childHashes = new Set<string>();
  for (const credential of candidates) {
    try {
      validatePaymentCredential(context, certificate, parent, credential);
      validCredentials.push(credential);
      childHashes.add(bytesToHex(credential.newStateHash));
    } catch (error) {
      rejected.push({ credential, reason: error instanceof OgpValidationError ? error.code : "UNKNOWN_ERROR" });
    }
  }
  return { authenticatedFork: childHashes.size > 1, branchCount: childHashes.size, validCredentials, rejected };
}

export function credentialHash(value: PaymentCredential): Uint8Array { return hashSha256(encodePaymentCredential(value)); }

export function verifyCredentialSignature(value: PaymentCredential): boolean {
  if (value.payerSignature.length !== SIGNATURE_LENGTH) return false;
  try { return verifyEd25519(value.payerSignature, encodePaymentCredentialPayload(value), value.payerDeviceKey); } catch { return false; }
}

export function signIdentityAttestation(payload: IdentityAttestationPayload, issuerSecretKey: Uint8Array): IdentityAttestation {
  return { ...payload, issuerSignature: signEd25519(encodeIdentityAttestationPayload(payload), issuerSecretKey) };
}

export function verifyIdentityAttestation(context: DomainContext, value: IdentityAttestation, trustedIdentityIssuer: Uint8Array): boolean {
  try {
    assertDomainContext(value.domain, context, ObjectType.IdentityAttestation);
    if (!equalBytes(value.issuer, trustedIdentityIssuer)) return false;
    return verifyEd25519(value.issuerSignature, encodeIdentityAttestationPayload(value), trustedIdentityIssuer);
  } catch {
    return false;
  }
}

export function identityAttestationHash(value: IdentityAttestation): Uint8Array {
  return hashSha256(encodeIdentityAttestation(value));
}

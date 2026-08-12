import { deserialize, serialize, type Schema } from "borsh";
import {
  CHALLENGE_LENGTH,
  DOMAIN_LENGTH,
  HASH_LENGTH,
  MAX_BRANCH_DEPTH,
  ObjectType,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  PUBLIC_KEY_LENGTH,
  SCHEMA_VERSION,
  SIGNATURE_LENGTH,
  assertBytes,
  assertI64,
  assertU16,
  assertU32,
  assertU64,
  assertU8,
  equalBytes,
  OgpValidationError,
  type DeviceAuthorization,
  type DeviceAuthorizationPayload,
  type Domain,
  type CredentialProofBundle,
  type GenesisState,
  type IdentityAttestation,
  type IdentityAttestationPayload,
  type PaymentCredential,
  type PaymentCredentialPayload,
  type PaymentState,
  type SessionCertificate,
  type SessionCertificatePayload,
} from "@ogp/shared-types";

const fixedBytes = (length: number): Schema => ({ array: { type: "u8", len: length } });

const domainFields = {
  protocolName: fixedBytes(8),
  protocolVersion: "u16",
  schemaVersion: "u16",
  objectType: "u8",
  networkId: "u8",
  clusterGenesisHash: fixedBytes(32),
  programId: fixedBytes(32),
  sessionId: fixedBytes(32),
} satisfies Record<string, Schema>;

export const domainSchema: Schema = { struct: domainFields };

const deviceAuthorizationFields = {
  ...domainFields,
  owner: fixedBytes(32),
  devicePublicKey: fixedBytes(32),
  payloadSessionId: fixedBytes(32),
  vault: fixedBytes(32),
  branchSpendingLimit: "u64",
  collateralCoverageCap: "u64",
  maxBranchDepth: "u32",
  issuedAt: "i64",
  expiresAt: "i64",
  authorizationNonce: fixedBytes(32),
} satisfies Record<string, Schema>;

const sessionCertificateFields = {
  ...domainFields,
  payloadSessionId: fixedBytes(32),
  owner: fixedBytes(32),
  devicePublicKey: fixedBytes(32),
  vault: fixedBytes(32),
  tokenMint: fixedBytes(32),
  branchSpendingLimit: "u64",
  collateralLocked: "u64",
  collateralCoverageCap: "u64",
  maxBranchDepth: "u32",
  issuedAt: "i64",
  expiresAt: "i64",
  claimSubmissionDeadline: "i64",
  genesisStateHash: fixedBytes(32),
  deviceAuthorizationHash: fixedBytes(32),
  identityAttestationHash: fixedBytes(32),
  issuer: fixedBytes(32),
  finalizedSlot: "u64",
  certificateNonce: fixedBytes(32),
} satisfies Record<string, Schema>;

const genesisStateFields = {
  ...domainFields,
  owner: fixedBytes(32),
  devicePublicKey: fixedBytes(32),
  branchSpendingLimit: "u64",
  maxBranchDepth: "u32",
  initialRemaining: "u64",
  issuedAt: "i64",
  expiresAt: "i64",
} satisfies Record<string, Schema>;

const paymentStateFields = {
  ...domainFields,
  previousStateHash: fixedBytes(32),
  sequence: "u32",
  merchant: fixedBytes(32),
  amount: "u64",
  merchantChallenge: fixedBytes(32),
  previousRemaining: "u64",
  newRemaining: "u64",
} satisfies Record<string, Schema>;

const paymentCredentialFields = {
  ...domainFields,
  payloadSessionId: fixedBytes(32),
  sequence: "u32",
  payer: fixedBytes(32),
  payerDeviceKey: fixedBytes(32),
  merchant: fixedBytes(32),
  merchantDeviceKey: fixedBytes(32),
  amount: "u64",
  previousStateHash: fixedBytes(32),
  newStateHash: fixedBytes(32),
  previousRemaining: "u64",
  newRemaining: "u64",
  merchantChallenge: fixedBytes(32),
  createdAt: "i64",
  sessionExpiresAt: "i64",
} satisfies Record<string, Schema>;

const identityAttestationFields = {
  ...domainFields,
  issuer: fixedBytes(32),
  subjectWallet: fixedBytes(32),
  assuranceLevel: "u8",
  issuedAt: "i64",
  expiresAt: "i64",
  attestationId: fixedBytes(32),
  status: "u8",
} satisfies Record<string, Schema>;

const schemas = {
  deviceAuthorizationPayload: { struct: deviceAuthorizationFields },
  deviceAuthorization: { struct: { ...deviceAuthorizationFields, walletSignature: fixedBytes(64) } },
  sessionCertificatePayload: { struct: sessionCertificateFields },
  sessionCertificate: { struct: { ...sessionCertificateFields, issuerSignature: fixedBytes(64) } },
  genesisState: { struct: genesisStateFields },
  paymentState: { struct: paymentStateFields },
  paymentCredentialPayload: { struct: paymentCredentialFields },
  paymentCredential: { struct: { ...paymentCredentialFields, payerSignature: fixedBytes(64) } },
  identityAttestationPayload: { struct: identityAttestationFields },
  identityAttestation: { struct: { ...identityAttestationFields, issuerSignature: fixedBytes(64) } },
} satisfies Record<string, Schema>;

const credentialProofBundleSchema: Schema = {
  struct: {
    sessionCertificate: schemas.sessionCertificate,
    deviceAuthorization: schemas.deviceAuthorization,
    credentials: { array: { type: schemas.paymentCredential } },
  },
};

export const ENCODED_LENGTHS = Object.freeze({
  domain: DOMAIN_LENGTH,
  deviceAuthorizationPayload: 306,
  deviceAuthorization: 370,
  sessionCertificatePayload: 490,
  sessionCertificate: 554,
  genesisState: 210,
  paymentState: 234,
  paymentCredentialPayload: 410,
  paymentCredential: 474,
  identityAttestationPayload: 224,
  identityAttestation: 288,
});

function bytes(value: Uint8Array): number[] {
  return Array.from(value);
}

function domainValue(domain: Domain): Record<string, unknown> {
  return {
    protocolName: bytes(domain.protocolName),
    protocolVersion: domain.protocolVersion,
    schemaVersion: domain.schemaVersion,
    objectType: domain.objectType,
    networkId: domain.networkId,
    clusterGenesisHash: bytes(domain.clusterGenesisHash),
    programId: bytes(domain.programId),
    sessionId: bytes(domain.sessionId),
  };
}

export function assertDomain(domain: Domain, expectedType?: ObjectType): void {
  assertBytes(domain.protocolName, 8, "domain.protocolName");
  if (!equalBytes(domain.protocolName, PROTOCOL_NAME)) throw new OgpValidationError("DOMAIN_MISMATCH", "protocol name mismatch");
  assertU16(domain.protocolVersion, "domain.protocolVersion");
  assertU16(domain.schemaVersion, "domain.schemaVersion");
  if (domain.protocolVersion !== PROTOCOL_VERSION || domain.schemaVersion !== SCHEMA_VERSION) {
    throw new OgpValidationError("DOMAIN_MISMATCH", "unsupported protocol or schema version");
  }
  assertU8(domain.objectType, "domain.objectType");
  assertU8(domain.networkId, "domain.networkId");
  if (domain.networkId > 2) throw new OgpValidationError("DOMAIN_MISMATCH", "unknown network id");
  if (expectedType !== undefined && domain.objectType !== expectedType) throw new OgpValidationError("DOMAIN_MISMATCH", "object type mismatch");
  assertBytes(domain.clusterGenesisHash, HASH_LENGTH, "domain.clusterGenesisHash");
  assertBytes(domain.programId, PUBLIC_KEY_LENGTH, "domain.programId");
  assertBytes(domain.sessionId, HASH_LENGTH, "domain.sessionId");
}

function commonValue<T extends { domain: Domain }>(value: T, type: ObjectType): Record<string, unknown> {
  assertDomain(value.domain, type);
  return domainValue(value.domain);
}

function encode(schema: Schema, value: Record<string, unknown>, expectedLength: number): Uint8Array {
  const encoded = serialize(schema, value);
  if (encoded.length !== expectedLength) throw new OgpValidationError("NON_CANONICAL_ENCODING", `expected ${expectedLength} bytes, got ${encoded.length}`);
  return encoded;
}

function deviceAuthorizationValue(value: DeviceAuthorizationPayload): Record<string, unknown> {
  assertBytes(value.owner, 32, "owner"); assertBytes(value.devicePublicKey, 32, "devicePublicKey");
  assertBytes(value.sessionId, 32, "sessionId"); assertBytes(value.vault, 32, "vault");
  assertU64(value.branchSpendingLimit, "branchSpendingLimit"); assertU64(value.collateralCoverageCap, "collateralCoverageCap");
  assertU32(value.maxBranchDepth, "maxBranchDepth"); assertI64(value.issuedAt, "issuedAt"); assertI64(value.expiresAt, "expiresAt");
  assertBytes(value.authorizationNonce, 32, "authorizationNonce");
  return { ...commonValue(value, ObjectType.DeviceAuthorization), owner: bytes(value.owner), devicePublicKey: bytes(value.devicePublicKey), payloadSessionId: bytes(value.sessionId), vault: bytes(value.vault), branchSpendingLimit: value.branchSpendingLimit, collateralCoverageCap: value.collateralCoverageCap, maxBranchDepth: value.maxBranchDepth, issuedAt: value.issuedAt, expiresAt: value.expiresAt, authorizationNonce: bytes(value.authorizationNonce) };
}

export function encodeDeviceAuthorizationPayload(value: DeviceAuthorizationPayload): Uint8Array {
  return encode(schemas.deviceAuthorizationPayload, deviceAuthorizationValue(value), ENCODED_LENGTHS.deviceAuthorizationPayload);
}

export function encodeDeviceAuthorization(value: DeviceAuthorization): Uint8Array {
  assertBytes(value.walletSignature, SIGNATURE_LENGTH, "walletSignature");
  return encode(schemas.deviceAuthorization, { ...deviceAuthorizationValue(value), walletSignature: bytes(value.walletSignature) }, ENCODED_LENGTHS.deviceAuthorization);
}

function sessionCertificateValue(value: SessionCertificatePayload): Record<string, unknown> {
  for (const [field, item] of [["sessionId", value.sessionId], ["owner", value.owner], ["devicePublicKey", value.devicePublicKey], ["vault", value.vault], ["tokenMint", value.tokenMint], ["genesisStateHash", value.genesisStateHash], ["deviceAuthorizationHash", value.deviceAuthorizationHash], ["identityAttestationHash", value.identityAttestationHash], ["issuer", value.issuer], ["certificateNonce", value.certificateNonce]] as const) assertBytes(item, 32, field);
  assertU64(value.branchSpendingLimit, "branchSpendingLimit"); assertU64(value.collateralLocked, "collateralLocked"); assertU64(value.collateralCoverageCap, "collateralCoverageCap"); assertU64(value.finalizedSlot, "finalizedSlot");
  assertU32(value.maxBranchDepth, "maxBranchDepth"); assertI64(value.issuedAt, "issuedAt"); assertI64(value.expiresAt, "expiresAt"); assertI64(value.claimSubmissionDeadline, "claimSubmissionDeadline");
  return { ...commonValue(value, ObjectType.SessionCertificate), payloadSessionId: bytes(value.sessionId), owner: bytes(value.owner), devicePublicKey: bytes(value.devicePublicKey), vault: bytes(value.vault), tokenMint: bytes(value.tokenMint), branchSpendingLimit: value.branchSpendingLimit, collateralLocked: value.collateralLocked, collateralCoverageCap: value.collateralCoverageCap, maxBranchDepth: value.maxBranchDepth, issuedAt: value.issuedAt, expiresAt: value.expiresAt, claimSubmissionDeadline: value.claimSubmissionDeadline, genesisStateHash: bytes(value.genesisStateHash), deviceAuthorizationHash: bytes(value.deviceAuthorizationHash), identityAttestationHash: bytes(value.identityAttestationHash), issuer: bytes(value.issuer), finalizedSlot: value.finalizedSlot, certificateNonce: bytes(value.certificateNonce) };
}

export function encodeSessionCertificatePayload(value: SessionCertificatePayload): Uint8Array { return encode(schemas.sessionCertificatePayload, sessionCertificateValue(value), ENCODED_LENGTHS.sessionCertificatePayload); }
export function encodeSessionCertificate(value: SessionCertificate): Uint8Array { assertBytes(value.issuerSignature, 64, "issuerSignature"); return encode(schemas.sessionCertificate, { ...sessionCertificateValue(value), issuerSignature: bytes(value.issuerSignature) }, ENCODED_LENGTHS.sessionCertificate); }

export function encodeGenesisState(value: GenesisState): Uint8Array {
  assertBytes(value.owner, 32, "owner"); assertBytes(value.devicePublicKey, 32, "devicePublicKey"); assertU64(value.branchSpendingLimit, "branchSpendingLimit"); assertU32(value.maxBranchDepth, "maxBranchDepth"); assertU64(value.initialRemaining, "initialRemaining"); assertI64(value.issuedAt, "issuedAt"); assertI64(value.expiresAt, "expiresAt");
  return encode(schemas.genesisState, { ...commonValue(value, ObjectType.GenesisState), owner: bytes(value.owner), devicePublicKey: bytes(value.devicePublicKey), branchSpendingLimit: value.branchSpendingLimit, maxBranchDepth: value.maxBranchDepth, initialRemaining: value.initialRemaining, issuedAt: value.issuedAt, expiresAt: value.expiresAt }, ENCODED_LENGTHS.genesisState);
}

export function encodePaymentState(value: PaymentState): Uint8Array {
  assertBytes(value.previousStateHash, 32, "previousStateHash"); assertU32(value.sequence, "sequence"); assertBytes(value.merchant, 32, "merchant"); assertU64(value.amount, "amount"); assertBytes(value.merchantChallenge, CHALLENGE_LENGTH, "merchantChallenge"); assertU64(value.previousRemaining, "previousRemaining"); assertU64(value.newRemaining, "newRemaining");
  return encode(schemas.paymentState, { ...commonValue(value, ObjectType.PaymentState), previousStateHash: bytes(value.previousStateHash), sequence: value.sequence, merchant: bytes(value.merchant), amount: value.amount, merchantChallenge: bytes(value.merchantChallenge), previousRemaining: value.previousRemaining, newRemaining: value.newRemaining }, ENCODED_LENGTHS.paymentState);
}

function paymentCredentialValue(value: PaymentCredentialPayload): Record<string, unknown> {
  for (const [field, item] of [["sessionId", value.sessionId], ["payer", value.payer], ["payerDeviceKey", value.payerDeviceKey], ["merchant", value.merchant], ["merchantDeviceKey", value.merchantDeviceKey], ["previousStateHash", value.previousStateHash], ["newStateHash", value.newStateHash], ["merchantChallenge", value.merchantChallenge]] as const) assertBytes(item, 32, field);
  assertU32(value.sequence, "sequence"); assertU64(value.amount, "amount"); assertU64(value.previousRemaining, "previousRemaining"); assertU64(value.newRemaining, "newRemaining"); assertI64(value.createdAt, "createdAt"); assertI64(value.sessionExpiresAt, "sessionExpiresAt");
  return { ...commonValue(value, ObjectType.PaymentCredential), payloadSessionId: bytes(value.sessionId), sequence: value.sequence, payer: bytes(value.payer), payerDeviceKey: bytes(value.payerDeviceKey), merchant: bytes(value.merchant), merchantDeviceKey: bytes(value.merchantDeviceKey), amount: value.amount, previousStateHash: bytes(value.previousStateHash), newStateHash: bytes(value.newStateHash), previousRemaining: value.previousRemaining, newRemaining: value.newRemaining, merchantChallenge: bytes(value.merchantChallenge), createdAt: value.createdAt, sessionExpiresAt: value.sessionExpiresAt };
}

export function encodePaymentCredentialPayload(value: PaymentCredentialPayload): Uint8Array { return encode(schemas.paymentCredentialPayload, paymentCredentialValue(value), ENCODED_LENGTHS.paymentCredentialPayload); }
export function encodePaymentCredential(value: PaymentCredential): Uint8Array { assertBytes(value.payerSignature, 64, "payerSignature"); return encode(schemas.paymentCredential, { ...paymentCredentialValue(value), payerSignature: bytes(value.payerSignature) }, ENCODED_LENGTHS.paymentCredential); }

function identityAttestationValue(value: IdentityAttestationPayload): Record<string, unknown> {
  assertBytes(value.issuer, 32, "issuer"); assertBytes(value.subjectWallet, 32, "subjectWallet"); assertU8(value.assuranceLevel, "assuranceLevel"); assertI64(value.issuedAt, "issuedAt"); assertI64(value.expiresAt, "expiresAt"); assertBytes(value.attestationId, 32, "attestationId"); assertU8(value.status, "status"); if (value.status > 1) throw new OgpValidationError("UNKNOWN_ENUM", "unknown attestation status");
  return { ...commonValue(value, ObjectType.IdentityAttestation), issuer: bytes(value.issuer), subjectWallet: bytes(value.subjectWallet), assuranceLevel: value.assuranceLevel, issuedAt: value.issuedAt, expiresAt: value.expiresAt, attestationId: bytes(value.attestationId), status: value.status };
}

export function encodeIdentityAttestationPayload(value: IdentityAttestationPayload): Uint8Array { return encode(schemas.identityAttestationPayload, identityAttestationValue(value), ENCODED_LENGTHS.identityAttestationPayload); }
export function encodeIdentityAttestation(value: IdentityAttestation): Uint8Array { assertBytes(value.issuerSignature, 64, "issuerSignature"); return encode(schemas.identityAttestation, { ...identityAttestationValue(value), issuerSignature: bytes(value.issuerSignature) }, ENCODED_LENGTHS.identityAttestation); }

export function credentialProofBundleEncodedLength(depth: number): number {
  assertU32(depth, "depth");
  if (depth > MAX_BRANCH_DEPTH) throw new OgpValidationError("BRANCH_DEPTH_EXCEEDED", `proof depth exceeds ${MAX_BRANCH_DEPTH}`);
  return ENCODED_LENGTHS.sessionCertificate + ENCODED_LENGTHS.deviceAuthorization + 4 + depth * ENCODED_LENGTHS.paymentCredential;
}

export function encodeCredentialProofBundle(value: CredentialProofBundle): Uint8Array {
  const expectedLength = credentialProofBundleEncodedLength(value.credentials.length);
  const encoded = serialize(credentialProofBundleSchema, {
    sessionCertificate: { ...sessionCertificateValue(value.sessionCertificate), issuerSignature: bytes(value.sessionCertificate.issuerSignature) },
    deviceAuthorization: { ...deviceAuthorizationValue(value.deviceAuthorization), walletSignature: bytes(value.deviceAuthorization.walletSignature) },
    credentials: value.credentials.map((credential) => ({ ...paymentCredentialValue(credential), payerSignature: bytes(credential.payerSignature) })),
  });
  if (encoded.length !== expectedLength) throw new OgpValidationError("NON_CANONICAL_ENCODING", `expected ${expectedLength} bundle bytes, got ${encoded.length}`);
  return encoded;
}

function decodedBytes(value: unknown, field: string): Uint8Array {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) throw new OgpValidationError("NON_CANONICAL_ENCODING", `${field} is not bytes`);
  return Uint8Array.from(value as number[]);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OgpValidationError("NON_CANONICAL_ENCODING", "decoded value is not a struct");
  return value as Record<string, unknown>;
}

function domainFromDecoded(value: Record<string, unknown>): Domain {
  return { protocolName: decodedBytes(value.protocolName, "protocolName"), protocolVersion: Number(value.protocolVersion), schemaVersion: Number(value.schemaVersion), objectType: Number(value.objectType) as Domain["objectType"], networkId: Number(value.networkId) as Domain["networkId"], clusterGenesisHash: decodedBytes(value.clusterGenesisHash, "clusterGenesisHash"), programId: decodedBytes(value.programId, "programId"), sessionId: decodedBytes(value.sessionId, "sessionId") };
}

function strictDecode(schema: Schema, input: Uint8Array, expectedLength: number): Record<string, unknown> {
  if (input.length !== expectedLength) throw new OgpValidationError("INVALID_LENGTH", `expected exactly ${expectedLength} bytes`);
  let decoded: Record<string, unknown>;
  try { decoded = record(deserialize(schema, input)); } catch (error) { throw new OgpValidationError("NON_CANONICAL_ENCODING", error instanceof Error ? error.message : "decode failed"); }
  if (!equalBytes(serialize(schema, decoded), input)) throw new OgpValidationError("NON_CANONICAL_ENCODING", "round-trip bytes differ");
  return decoded;
}

export function decodePaymentCredential(input: Uint8Array): PaymentCredential {
  const value = strictDecode(schemas.paymentCredential, input, ENCODED_LENGTHS.paymentCredential);
  const result: PaymentCredential = { domain: domainFromDecoded(value), sessionId: decodedBytes(value.payloadSessionId, "sessionId"), sequence: Number(value.sequence), payer: decodedBytes(value.payer, "payer"), payerDeviceKey: decodedBytes(value.payerDeviceKey, "payerDeviceKey"), merchant: decodedBytes(value.merchant, "merchant"), merchantDeviceKey: decodedBytes(value.merchantDeviceKey, "merchantDeviceKey"), amount: BigInt(value.amount as bigint), previousStateHash: decodedBytes(value.previousStateHash, "previousStateHash"), newStateHash: decodedBytes(value.newStateHash, "newStateHash"), previousRemaining: BigInt(value.previousRemaining as bigint), newRemaining: BigInt(value.newRemaining as bigint), merchantChallenge: decodedBytes(value.merchantChallenge, "merchantChallenge"), createdAt: BigInt(value.createdAt as bigint), sessionExpiresAt: BigInt(value.sessionExpiresAt as bigint), payerSignature: decodedBytes(value.payerSignature, "payerSignature") };
  paymentCredentialValue(result); return result;
}

export function decodeDeviceAuthorization(input: Uint8Array): DeviceAuthorization {
  const value = strictDecode(schemas.deviceAuthorization, input, ENCODED_LENGTHS.deviceAuthorization);
  const result: DeviceAuthorization = { domain: domainFromDecoded(value), owner: decodedBytes(value.owner, "owner"), devicePublicKey: decodedBytes(value.devicePublicKey, "devicePublicKey"), sessionId: decodedBytes(value.payloadSessionId, "sessionId"), vault: decodedBytes(value.vault, "vault"), branchSpendingLimit: BigInt(value.branchSpendingLimit as bigint), collateralCoverageCap: BigInt(value.collateralCoverageCap as bigint), maxBranchDepth: Number(value.maxBranchDepth), issuedAt: BigInt(value.issuedAt as bigint), expiresAt: BigInt(value.expiresAt as bigint), authorizationNonce: decodedBytes(value.authorizationNonce, "authorizationNonce"), walletSignature: decodedBytes(value.walletSignature, "walletSignature") };
  deviceAuthorizationValue(result); return result;
}

export function decodeSessionCertificate(input: Uint8Array): SessionCertificate {
  const value = strictDecode(schemas.sessionCertificate, input, ENCODED_LENGTHS.sessionCertificate);
  const result: SessionCertificate = { domain: domainFromDecoded(value), sessionId: decodedBytes(value.payloadSessionId, "sessionId"), owner: decodedBytes(value.owner, "owner"), devicePublicKey: decodedBytes(value.devicePublicKey, "devicePublicKey"), vault: decodedBytes(value.vault, "vault"), tokenMint: decodedBytes(value.tokenMint, "tokenMint"), branchSpendingLimit: BigInt(value.branchSpendingLimit as bigint), collateralLocked: BigInt(value.collateralLocked as bigint), collateralCoverageCap: BigInt(value.collateralCoverageCap as bigint), maxBranchDepth: Number(value.maxBranchDepth), issuedAt: BigInt(value.issuedAt as bigint), expiresAt: BigInt(value.expiresAt as bigint), claimSubmissionDeadline: BigInt(value.claimSubmissionDeadline as bigint), genesisStateHash: decodedBytes(value.genesisStateHash, "genesisStateHash"), deviceAuthorizationHash: decodedBytes(value.deviceAuthorizationHash, "deviceAuthorizationHash"), identityAttestationHash: decodedBytes(value.identityAttestationHash, "identityAttestationHash"), issuer: decodedBytes(value.issuer, "issuer"), finalizedSlot: BigInt(value.finalizedSlot as bigint), certificateNonce: decodedBytes(value.certificateNonce, "certificateNonce"), issuerSignature: decodedBytes(value.issuerSignature, "issuerSignature") };
  sessionCertificateValue(result); return result;
}

export const PROTOCOL_NAME = Uint8Array.of(0x4f, 0x47, 0x50, 0, 0, 0, 0, 0);
export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;
export const HASH_LENGTH = 32;
export const PUBLIC_KEY_LENGTH = 32;
export const SIGNATURE_LENGTH = 64;
export const CHALLENGE_LENGTH = 32;
export const DOMAIN_LENGTH = 110;
export const MAX_BRANCH_DEPTH = 32;

export const U32_MAX = 0xffff_ffff;
export const U64_MAX = (1n << 64n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

export enum NetworkId {
  Localnet = 0,
  Devnet = 1,
  MainnetBeta = 2,
}

export enum ObjectType {
  DeviceAuthorization = 1,
  SessionCertificate = 2,
  GenesisState = 3,
  PaymentState = 4,
  PaymentCredential = 5,
  MerchantReceipt = 6,
  ClaimCommitment = 7,
  ForkWitness = 8,
  ResolutionPlan = 9,
  IdentityAttestation = 10,
}

export enum AttestationStatus {
  Active = 0,
  Revoked = 1,
}

export interface Domain {
  readonly protocolName: Uint8Array;
  readonly protocolVersion: number;
  readonly schemaVersion: number;
  readonly objectType: ObjectType;
  readonly networkId: NetworkId;
  readonly clusterGenesisHash: Uint8Array;
  readonly programId: Uint8Array;
  readonly sessionId: Uint8Array;
}

export interface DomainContext {
  readonly networkId: NetworkId;
  readonly clusterGenesisHash: Uint8Array;
  readonly programId: Uint8Array;
  readonly sessionId: Uint8Array;
}

export interface ProtocolTrustContext extends DomainContext {
  readonly trustedCertificateIssuer: Uint8Array;
}

export interface DeviceAuthorizationPayload {
  readonly domain: Domain;
  readonly owner: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly vault: Uint8Array;
  readonly branchSpendingLimit: bigint;
  readonly collateralCoverageCap: bigint;
  readonly maxBranchDepth: number;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly authorizationNonce: Uint8Array;
}

export interface DeviceAuthorization extends DeviceAuthorizationPayload {
  readonly walletSignature: Uint8Array;
}

export interface SessionCertificatePayload {
  readonly domain: Domain;
  readonly sessionId: Uint8Array;
  readonly owner: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly vault: Uint8Array;
  readonly tokenMint: Uint8Array;
  readonly branchSpendingLimit: bigint;
  readonly collateralLocked: bigint;
  readonly collateralCoverageCap: bigint;
  readonly maxBranchDepth: number;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly claimSubmissionDeadline: bigint;
  readonly genesisStateHash: Uint8Array;
  readonly deviceAuthorizationHash: Uint8Array;
  readonly identityAttestationHash: Uint8Array;
  readonly issuer: Uint8Array;
  readonly finalizedSlot: bigint;
  readonly certificateNonce: Uint8Array;
}

export interface SessionCertificate extends SessionCertificatePayload {
  readonly issuerSignature: Uint8Array;
}

export interface GenesisState {
  readonly domain: Domain;
  readonly owner: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly branchSpendingLimit: bigint;
  readonly maxBranchDepth: number;
  readonly initialRemaining: bigint;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

export interface PaymentState {
  readonly domain: Domain;
  readonly previousStateHash: Uint8Array;
  readonly sequence: number;
  readonly merchant: Uint8Array;
  readonly amount: bigint;
  readonly merchantChallenge: Uint8Array;
  readonly previousRemaining: bigint;
  readonly newRemaining: bigint;
}

export interface PaymentCredentialPayload {
  readonly domain: Domain;
  readonly sessionId: Uint8Array;
  readonly sequence: number;
  readonly payer: Uint8Array;
  readonly payerDeviceKey: Uint8Array;
  readonly merchant: Uint8Array;
  readonly merchantDeviceKey: Uint8Array;
  readonly amount: bigint;
  readonly previousStateHash: Uint8Array;
  readonly newStateHash: Uint8Array;
  readonly previousRemaining: bigint;
  readonly newRemaining: bigint;
  readonly merchantChallenge: Uint8Array;
  readonly createdAt: bigint;
  readonly sessionExpiresAt: bigint;
}

export interface PaymentCredential extends PaymentCredentialPayload {
  readonly payerSignature: Uint8Array;
}

export interface CredentialProofBundle {
  readonly sessionCertificate: SessionCertificate;
  readonly deviceAuthorization: DeviceAuthorization;
  readonly credentials: readonly PaymentCredential[];
}

export interface IdentityAttestationPayload {
  readonly domain: Domain;
  readonly issuer: Uint8Array;
  readonly subjectWallet: Uint8Array;
  readonly assuranceLevel: number;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly attestationId: Uint8Array;
  readonly status: AttestationStatus;
}

export interface IdentityAttestation extends IdentityAttestationPayload {
  readonly issuerSignature: Uint8Array;
}

export class OgpValidationError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OgpValidationError";
  }
}

export function assertBytes(value: Uint8Array, length: number, field: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new OgpValidationError("INVALID_LENGTH", `${field} must be exactly ${length} bytes`);
  }
}

export function assertU8(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new OgpValidationError("INTEGER_OUT_OF_RANGE", `${field} must be a u8`);
  }
}

export function assertU16(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new OgpValidationError("INTEGER_OUT_OF_RANGE", `${field} must be a u16`);
  }
}

export function assertU32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new OgpValidationError("INTEGER_OUT_OF_RANGE", `${field} must be a u32`);
  }
}

export function assertU64(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new OgpValidationError("INTEGER_OUT_OF_RANGE", `${field} must be a u64`);
  }
}

export function assertI64(value: bigint, field: string): void {
  if (typeof value !== "bigint" || value < I64_MIN || value > I64_MAX) {
    throw new OgpValidationError("INTEGER_OUT_OF_RANGE", `${field} must be an i64`);
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

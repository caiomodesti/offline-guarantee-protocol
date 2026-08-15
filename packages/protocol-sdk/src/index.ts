import { encodePaymentCredentialPayload } from "@ogp/canonical-codec";
import { credentialHash } from "@ogp/credentials";
import type { PaymentCredential } from "@ogp/shared-types";

export const PAYMENT_CREDENTIAL_PAYLOAD_SIZE = 410;
export const ED25519_SIGNATURE_SIZE = 64;
export const USER_PROFILE_ACCOUNT_SIZE = 163;
export const OFFLINE_SESSION_ACCOUNT_SIZE = 530;
export const CLAIM_ACCOUNT_SIZE = 272;
export const STATE_EDGE_RECORD_ACCOUNT_SIZE = 228;

export const USER_PROFILE_DISCRIMINATOR = Uint8Array.of(32, 37, 119, 205, 179, 180, 13, 194);
export const OFFLINE_SESSION_DISCRIMINATOR = Uint8Array.of(29, 211, 31, 106, 205, 160, 10, 15);
export const CLAIM_DISCRIMINATOR = Uint8Array.of(155, 70, 22, 176, 123, 215, 246, 102);
export const STATE_EDGE_RECORD_DISCRIMINATOR = Uint8Array.of(204, 197, 54, 127, 253, 121, 58, 245);

export type SessionStatus = "active" | "claimWindow" | "conflicted" | "reconciling" | "settled" | "insolvent" | "closed";
export type CoverageStatus = "uncalculated" | "fullyCovered" | "insolvent";
export type ClaimStatus = "submitted" | "valid" | "conflicting" | "settled" | "rejected";
export type ClaimRejectionReason = "none" | "duplicateStateEdge";

export interface ClaimSubmissionMaterial {
  readonly payload: Uint8Array;
  readonly payerSignature: Uint8Array;
  readonly credentialHash: Uint8Array;
}

/**
 * Bridges a merchant-verified portable credential to submit_claim without
 * reserializing fields in application code.
 */
export function createClaimSubmissionMaterial(credential: PaymentCredential): ClaimSubmissionMaterial {
  const payload = encodePaymentCredentialPayload(credential);
  const payerSignature = credential.payerSignature.slice();
  const hash = credentialHash(credential);
  if (payload.length !== PAYMENT_CREDENTIAL_PAYLOAD_SIZE) throw new Error("payment credential payload layout mismatch");
  if (payerSignature.length !== ED25519_SIGNATURE_SIZE) throw new Error("payer signature must contain exactly 64 bytes");
  if (hash.length !== 32) throw new Error("credential hash must contain exactly 32 bytes");
  return { payload, payerSignature, credentialHash: hash };
}

export interface DecodedUserProfile {
  readonly owner: Uint8Array;
  readonly identityAttestationHash: Uint8Array;
  readonly identityIssuer: Uint8Array;
  readonly riskTier: number;
  readonly offlineAccessEnabled: boolean;
  readonly successfulSessions: number;
  readonly conflictCount: number;
  readonly revokedAt: bigint;
  readonly identityExpiresAt: bigint;
  readonly activeSession: Uint8Array;
  readonly bump: number;
}

export interface DecodedOfflineSession {
  readonly sessionId: Uint8Array;
  readonly owner: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly collateralVault: Uint8Array;
  readonly collateralLocked: bigint;
  readonly branchSpendingLimit: bigint;
  readonly collateralCoverageCap: bigint;
  readonly maxBranchDepth: number;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly claimSubmissionDeadline: bigint;
  readonly status: SessionStatus;
  readonly authenticatedFork: boolean;
  readonly coverageStatus: CoverageStatus;
  readonly genesisStateHash: Uint8Array;
  readonly deviceAuthorizationHash: Uint8Array;
  readonly identityAttestationHash: Uint8Array;
  readonly settledAmount: bigint;
  readonly aggregateOfflineExposure: bigint;
  readonly uniqueEdgeCount: bigint;
  readonly conflictingClaimCount: bigint;
  readonly resolutionHash: Uint8Array;
  readonly bump: number;
  readonly frozenEdgeCount: bigint;
  readonly frozenExposure: bigint;
  readonly submittedClaimCount: bigint;
  readonly classifiedEdgeCount: bigint;
  readonly classifiedExposure: bigint;
  readonly baseAllocationTotal: bigint;
  readonly allocatedEdgeCount: bigint;
  readonly allocatedTotal: bigint;
  readonly scannedClaimCount: bigint;
  readonly settledEdgeCount: bigint;
  readonly claimHead: Uint8Array;
  readonly claimTail: Uint8Array;
  readonly nextAllocationClaim: Uint8Array;
  readonly classificationComplete: boolean;
  readonly allocationComplete: boolean;
}

export interface DecodedClaim {
  readonly credentialHash: Uint8Array;
  readonly session: Uint8Array;
  readonly merchant: Uint8Array;
  readonly amount: bigint;
  readonly sequence: number;
  readonly previousStateHash: Uint8Array;
  readonly newStateHash: Uint8Array;
  readonly submittedSlot: bigint;
  readonly status: ClaimStatus;
  readonly rejectionReason: ClaimRejectionReason;
  readonly allocatedAmount: bigint;
  readonly settledAmount: bigint;
  readonly bump: number;
  readonly previousClaim: Uint8Array;
  readonly nextClaim: Uint8Array;
  readonly allocationProcessed: boolean;
}

export interface DecodedStateEdgeRecord {
  readonly session: Uint8Array;
  readonly previousStateHash: Uint8Array;
  readonly sequence: number;
  readonly newStateHash: Uint8Array;
  readonly merchant: Uint8Array;
  readonly amount: bigint;
  readonly previousRemaining: bigint;
  readonly newRemaining: bigint;
  readonly representativeCredentialHash: Uint8Array;
  readonly wrapperCount: number;
  readonly submittedSlot: bigint;
  readonly allocatedAmount: bigint;
  readonly settledAmount: bigint;
  readonly bump: number;
  readonly classified: boolean;
  readonly conflicting: boolean;
  readonly allocationFinalized: boolean;
}

function bytes(value: Uint8Array, start: number, length: number): Uint8Array {
  return value.slice(start, start + length);
}

function assertAccount(value: Uint8Array, size: number, discriminator: Uint8Array, name: string): void {
  if (value.length !== size) throw new Error(`${name} account must contain exactly ${size} bytes`);
  if (!discriminator.every((byte, index) => value[index] === byte)) {
    throw new Error(`${name} account discriminator mismatch`);
  }
}

function view(value: Uint8Array): DataView {
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

function claimStatus(value: number): ClaimStatus {
  const statuses: readonly ClaimStatus[] = ["submitted", "valid", "conflicting", "settled", "rejected"];
  const status = statuses[value];
  if (status === undefined) throw new Error(`unknown ClaimStatus variant ${value}`);
  return status;
}

function rejectionReason(value: number): ClaimRejectionReason {
  const reasons: readonly ClaimRejectionReason[] = ["none", "duplicateStateEdge"];
  const reason = reasons[value];
  if (reason === undefined) throw new Error(`unknown ClaimRejectionReason variant ${value}`);
  return reason;
}

function sessionStatus(value: number): SessionStatus {
  const statuses: readonly SessionStatus[] = ["active", "claimWindow", "conflicted", "reconciling", "settled", "insolvent", "closed"];
  const status = statuses[value];
  if (status === undefined) throw new Error(`unknown SessionStatus variant ${value}`);
  return status;
}

function coverageStatus(value: number): CoverageStatus {
  const statuses: readonly CoverageStatus[] = ["uncalculated", "fullyCovered", "insolvent"];
  const status = statuses[value];
  if (status === undefined) throw new Error(`unknown CoverageStatus variant ${value}`);
  return status;
}

export function decodeUserProfile(value: Uint8Array): DecodedUserProfile {
  assertAccount(value, USER_PROFILE_ACCOUNT_SIZE, USER_PROFILE_DISCRIMINATOR, "UserProfile");
  const data = view(value);
  return {
    owner: bytes(value, 8, 32),
    identityAttestationHash: bytes(value, 40, 32),
    identityIssuer: bytes(value, 72, 32),
    riskTier: data.getUint8(104),
    offlineAccessEnabled: data.getUint8(105) !== 0,
    successfulSessions: data.getUint32(106, true),
    conflictCount: data.getUint32(110, true),
    revokedAt: data.getBigInt64(114, true),
    identityExpiresAt: data.getBigInt64(122, true),
    activeSession: bytes(value, 130, 32),
    bump: data.getUint8(162),
  };
}

export function decodeOfflineSession(value: Uint8Array): DecodedOfflineSession {
  assertAccount(value, OFFLINE_SESSION_ACCOUNT_SIZE, OFFLINE_SESSION_DISCRIMINATOR, "OfflineSession");
  const data = view(value);
  return {
    sessionId: bytes(value, 8, 32),
    owner: bytes(value, 40, 32),
    devicePublicKey: bytes(value, 72, 32),
    collateralVault: bytes(value, 104, 32),
    collateralLocked: data.getBigUint64(136, true),
    branchSpendingLimit: data.getBigUint64(144, true),
    collateralCoverageCap: data.getBigUint64(152, true),
    maxBranchDepth: data.getUint32(160, true),
    issuedAt: data.getBigInt64(164, true),
    expiresAt: data.getBigInt64(172, true),
    claimSubmissionDeadline: data.getBigInt64(180, true),
    status: sessionStatus(data.getUint8(188)),
    authenticatedFork: data.getUint8(189) !== 0,
    coverageStatus: coverageStatus(data.getUint8(190)),
    genesisStateHash: bytes(value, 191, 32),
    deviceAuthorizationHash: bytes(value, 223, 32),
    identityAttestationHash: bytes(value, 255, 32),
    settledAmount: data.getBigUint64(287, true),
    aggregateOfflineExposure: data.getBigUint64(295, true),
    uniqueEdgeCount: data.getBigUint64(303, true),
    conflictingClaimCount: data.getBigUint64(311, true),
    resolutionHash: bytes(value, 319, 32),
    bump: data.getUint8(351),
    frozenEdgeCount: data.getBigUint64(352, true),
    frozenExposure: data.getBigUint64(360, true),
    submittedClaimCount: data.getBigUint64(368, true),
    classifiedEdgeCount: data.getBigUint64(376, true),
    classifiedExposure: data.getBigUint64(384, true),
    baseAllocationTotal: data.getBigUint64(392, true),
    allocatedEdgeCount: data.getBigUint64(400, true),
    allocatedTotal: data.getBigUint64(408, true),
    scannedClaimCount: data.getBigUint64(416, true),
    settledEdgeCount: data.getBigUint64(424, true),
    claimHead: bytes(value, 432, 32),
    claimTail: bytes(value, 464, 32),
    nextAllocationClaim: bytes(value, 496, 32),
    classificationComplete: data.getUint8(528) !== 0,
    allocationComplete: data.getUint8(529) !== 0,
  };
}

export function decodeClaim(value: Uint8Array): DecodedClaim {
  assertAccount(value, CLAIM_ACCOUNT_SIZE, CLAIM_DISCRIMINATOR, "Claim");
  const data = view(value);
  return {
    credentialHash: bytes(value, 8, 32),
    session: bytes(value, 40, 32),
    merchant: bytes(value, 72, 32),
    amount: data.getBigUint64(104, true),
    sequence: data.getUint32(112, true),
    previousStateHash: bytes(value, 116, 32),
    newStateHash: bytes(value, 148, 32),
    submittedSlot: data.getBigUint64(180, true),
    status: claimStatus(data.getUint8(188)),
    rejectionReason: rejectionReason(data.getUint8(189)),
    allocatedAmount: data.getBigUint64(190, true),
    settledAmount: data.getBigUint64(198, true),
    bump: data.getUint8(206),
    previousClaim: bytes(value, 207, 32),
    nextClaim: bytes(value, 239, 32),
    allocationProcessed: data.getUint8(271) !== 0,
  };
}

export function decodeStateEdgeRecord(value: Uint8Array): DecodedStateEdgeRecord {
  assertAccount(value, STATE_EDGE_RECORD_ACCOUNT_SIZE, STATE_EDGE_RECORD_DISCRIMINATOR, "StateEdgeRecord");
  const data = view(value);
  return {
    session: bytes(value, 8, 32),
    previousStateHash: bytes(value, 40, 32),
    sequence: data.getUint32(72, true),
    newStateHash: bytes(value, 76, 32),
    merchant: bytes(value, 108, 32),
    amount: data.getBigUint64(140, true),
    previousRemaining: data.getBigUint64(148, true),
    newRemaining: data.getBigUint64(156, true),
    representativeCredentialHash: bytes(value, 164, 32),
    wrapperCount: data.getUint32(196, true),
    submittedSlot: data.getBigUint64(200, true),
    allocatedAmount: data.getBigUint64(208, true),
    settledAmount: data.getBigUint64(216, true),
    bump: data.getUint8(224),
    classified: data.getUint8(225) !== 0,
    conflicting: data.getUint8(226) !== 0,
    allocationFinalized: data.getUint8(227) !== 0,
  };
}

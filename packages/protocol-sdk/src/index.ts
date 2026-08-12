export const CLAIM_ACCOUNT_SIZE = 207;
export const STATE_EDGE_RECORD_ACCOUNT_SIZE = 225;

export const CLAIM_DISCRIMINATOR = Uint8Array.of(155, 70, 22, 176, 123, 215, 246, 102);
export const STATE_EDGE_RECORD_DISCRIMINATOR = Uint8Array.of(204, 197, 54, 127, 253, 121, 58, 245);

export type ClaimStatus = "submitted" | "valid" | "conflicting" | "settled" | "rejected";
export type ClaimRejectionReason = "none" | "duplicateStateEdge";

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
  };
}

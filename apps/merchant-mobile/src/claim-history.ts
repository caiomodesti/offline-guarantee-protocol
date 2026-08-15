export type ReceiptPresentation = "not-shown" | "shown" | "unknown";

export interface StoredClaim {
  readonly credentialHash: string;
  readonly amount: string;
  readonly sessionId: string;
  readonly frames: readonly string[];
  readonly status: "pending-settlement";
  readonly receiptPresentation: ReceiptPresentation;
}

export interface ClaimBranchDescriptor {
  readonly credentialHash: string;
  readonly sessionId: string;
  readonly parentStateHash: string;
  readonly sequence: number;
  readonly resultingStateHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCanonicalHex(value: unknown, bytes?: number): value is string {
  return typeof value === "string" && /^[0-9a-f]+$/.test(value) && value.length % 2 === 0 && (bytes === undefined || value.length === bytes * 2);
}

function normalizeClaim(value: unknown): StoredClaim | null {
  if (!isRecord(value)) return null;
  if (!isCanonicalHex(value.credentialHash, 32) || !isCanonicalHex(value.sessionId, 32)) return null;
  if (typeof value.amount !== "string" || !/^[1-9][0-9]*$/.test(value.amount)) return null;
  if (!Array.isArray(value.frames) || value.frames.length === 0 || !value.frames.every((frame) => typeof frame === "string" && frame.length > 0)) return null;
  if (value.status !== "pending-settlement") return null;
  const receiptPresentation = value.receiptPresentation === "not-shown" || value.receiptPresentation === "shown"
    ? value.receiptPresentation
    : "unknown";
  return {
    credentialHash: value.credentialHash,
    amount: value.amount,
    sessionId: value.sessionId,
    frames: [...value.frames],
    status: "pending-settlement",
    receiptPresentation,
  };
}

/** Parses both the current format and Sprint 7 legacy entries without inventing receipt state. */
export function parseStoredClaims(serialized: string | null): StoredClaim[] {
  if (serialized === null) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  return decoded.flatMap((entry) => {
    const claim = normalizeClaim(entry);
    return claim === null ? [] : [claim];
  });
}

export function markReceiptShown(claims: readonly StoredClaim[], credentialHash: string): StoredClaim[] {
  return claims.map((claim) => claim.credentialHash === credentialHash ? { ...claim, receiptPresentation: "shown" } : claim);
}

/**
 * Local warning only. Protocol-level FORK DETECTED still requires reconciliation evidence.
 * Formal candidate: same session + same parent + same sequence + different resulting state.
 */
export function findPotentialConflictHashes(descriptors: readonly ClaimBranchDescriptor[]): ReadonlySet<string> {
  const groups = new Map<string, ClaimBranchDescriptor[]>();
  for (const descriptor of descriptors) {
    const key = `${descriptor.sessionId}:${descriptor.parentStateHash}:${descriptor.sequence}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [descriptor]);
    else group.push(descriptor);
  }

  const result = new Set<string>();
  for (const group of groups.values()) {
    if (new Set(group.map((descriptor) => descriptor.resultingStateHash)).size <= 1) continue;
    for (const descriptor of group) result.add(descriptor.credentialHash);
  }
  return result;
}

export function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

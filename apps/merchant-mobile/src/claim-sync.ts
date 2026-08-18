import type { ClaimLifecycleStatus, StoredClaim } from "./claim-history";

export type AuthoritativeClaimStatus = "submitted" | "valid" | "conflicting" | "settled" | "rejected";

export interface AuthoritativeClaimSnapshot {
  readonly confirmed: boolean;
  readonly credentialHash: string;
  readonly sessionId: string;
  readonly amount: string;
  readonly status: AuthoritativeClaimStatus;
  readonly confirmedSlot: string;
  readonly transactionSignature: string | null;
}

export interface ClaimSubmissionPort {
  /** Returns only the claim account addressed by the credential hash. */
  readonly lookupConfirmedClaim: (claim: StoredClaim) => Promise<AuthoritativeClaimSnapshot | null>;
  /** Submits the exact stored proof. The payer is never required here. */
  readonly submitClaim: (claim: StoredClaim) => Promise<{ readonly transactionSignature: string }>;
  readonly confirmTransaction: (transactionSignature: string) => Promise<void>;
}

export interface ClaimQueueSyncResult {
  readonly claims: readonly StoredClaim[];
  readonly attempted: number;
  readonly confirmed: number;
  readonly failed: number;
}

export type PersistClaimQueue = (claims: readonly StoredClaim[]) => Promise<void>;

function lifecycleStatus(status: AuthoritativeClaimStatus): ClaimLifecycleStatus {
  if (status === "settled") return "settled";
  if (status === "rejected") return "rejected";
  return "submitted";
}

function assertSnapshotMatches(claim: StoredClaim, snapshot: AuthoritativeClaimSnapshot): void {
  if (!snapshot.confirmed) throw new Error("claim on-chain ainda não está confirmado");
  if (snapshot.credentialHash !== claim.credentialHash) throw new Error("credential hash on-chain divergente");
  if (snapshot.sessionId !== claim.sessionId) throw new Error("sessão do claim on-chain divergente");
  if (snapshot.amount !== claim.amount) throw new Error("valor do claim on-chain divergente");
  if (!/^(0|[1-9][0-9]*)$/.test(snapshot.confirmedSlot)) throw new Error("slot confirmado do claim é inválido");
}

function applySnapshot(claim: StoredClaim, snapshot: AuthoritativeClaimSnapshot, fallbackSignature: string | null): StoredClaim {
  assertSnapshotMatches(claim, snapshot);
  return {
    ...claim,
    status: lifecycleStatus(snapshot.status),
    transactionSignature: snapshot.transactionSignature ?? fallbackSignature ?? claim.transactionSignature,
    lastConfirmedSlot: snapshot.confirmedSlot,
    lastSubmissionError: null,
  };
}

function failedAttempt(claim: StoredClaim, reason: unknown): StoredClaim {
  const message = reason instanceof Error ? reason.message : "falha desconhecida ao enviar claim";
  return {
    ...claim,
    submissionAttempts: claim.submissionAttempts + 1,
    lastSubmissionError: message,
  };
}

async function lookupAfterAmbiguousFailure(claim: StoredClaim, port: ClaimSubmissionPort): Promise<AuthoritativeClaimSnapshot | null> {
  try {
    return await port.lookupConfirmedClaim(claim);
  } catch {
    return null;
  }
}

/**
 * Idempotent reconnect path for one locally durable proof.
 *
 * The claim account is checked before submission and after any ambiguous
 * submit/confirmation failure. Local state advances only from a confirmed,
 * field-matching on-chain account; a transaction signature alone is never
 * represented as successful settlement.
 */
export async function syncStoredClaim(claim: StoredClaim, port: ClaimSubmissionPort): Promise<StoredClaim> {
  if (claim.status === "settled" || claim.status === "rejected") return claim;

  try {
    const existing = await port.lookupConfirmedClaim(claim);
    if (existing !== null) return applySnapshot(claim, existing, null);
  } catch (reason) {
    return failedAttempt(claim, reason);
  }

  let signature: string | null = null;
  try {
    const submitted = await port.submitClaim(claim);
    signature = submitted.transactionSignature;
    await port.confirmTransaction(signature);
    const confirmed = await port.lookupConfirmedClaim(claim);
    if (confirmed === null) throw new Error("transação confirmou sem claim on-chain observável");
    return applySnapshot({ ...claim, submissionAttempts: claim.submissionAttempts + 1 }, confirmed, signature);
  } catch (reason) {
    const confirmed = await lookupAfterAmbiguousFailure(claim, port);
    if (confirmed !== null) {
      return applySnapshot({ ...claim, submissionAttempts: claim.submissionAttempts + 1 }, confirmed, signature);
    }
    return failedAttempt(claim, reason);
  }
}

/** Processes every eligible proof in deterministic hash order without allowing one failure to starve the rest. */
export async function syncClaimQueue(
  claims: readonly StoredClaim[],
  connected: boolean,
  port: ClaimSubmissionPort,
  persist?: PersistClaimQueue,
): Promise<ClaimQueueSyncResult> {
  if (!connected) return { claims: [...claims], attempted: 0, confirmed: 0, failed: 0 };

  const updates = new Map<string, StoredClaim>();
  let attempted = 0;
  let confirmed = 0;
  let failed = 0;
  const eligible = claims
    .filter((claim) => claim.status === "pending-submission" || claim.status === "submitted")
    .sort((left, right) => left.credentialHash.localeCompare(right.credentialHash));

  for (const claim of eligible) {
    attempted += 1;
    const updated = await syncStoredClaim(claim, port);
    updates.set(claim.credentialHash, updated);
    if (persist !== undefined) {
      await persist(claims.map((item) => updates.get(item.credentialHash) ?? item));
    }
    if (updated.lastSubmissionError !== null) failed += 1;
    else confirmed += 1;
  }

  return {
    claims: claims.map((claim) => updates.get(claim.credentialHash) ?? claim),
    attempted,
    confirmed,
    failed,
  };
}

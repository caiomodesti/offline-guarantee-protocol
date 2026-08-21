import { hashSha256 } from "@ogp/crypto";
import {
  buildStateGraph,
  type BuildStateGraphInput,
  type DuplicateCredential,
  type ForkPoint,
  type RejectedCredential,
  type StateEdge,
  type StateGraph,
} from "@ogp/offline-ledger";

const GRAPH_COMMITMENT_PREFIX = new TextEncoder().encode("OGP:STATE_GRAPH:V1\0");
const U64_MAX = (1n << 64n) - 1n;

export type ReconciledClaimClassification = "VALID" | "CONFLICTING";

export interface ReconciledClaim {
  readonly edge: StateEdge;
  readonly classification: ReconciledClaimClassification;
}

export interface ReconciliationResult {
  readonly sessionId: Uint8Array;
  readonly stateGraph: StateGraph;
  readonly eligibleClaims: readonly ReconciledClaim[];
  readonly validClaims: readonly ReconciledClaim[];
  readonly conflictingClaims: readonly ReconciledClaim[];
  readonly invalidCredentials: readonly RejectedCredential[];
  readonly duplicateCredentials: readonly DuplicateCredential[];
  readonly forks: readonly ForkPoint[];
  readonly aggregateOfflineExposure: bigint;
  readonly conflictingExposure: bigint;
  readonly stateGraphCommitment: Uint8Array;
}

export interface CoverageAllocation {
  readonly credentialHash: Uint8Array;
  readonly merchant: Uint8Array;
  readonly amount: bigint;
  readonly baseAllocation: bigint;
  readonly dust: bigint;
  readonly payout: bigint;
}

export interface DeterministicCoverageResult {
  readonly aggregateOfflineExposure: bigint;
  readonly collateralCoverageCap: bigint;
  readonly coverage: bigint;
  readonly baseAllocationTotal: bigint;
  readonly dustUnits: bigint;
  readonly totalPayout: bigint;
  readonly insolvent: boolean;
  readonly allocations: readonly CoverageAllocation[];
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("GRAPH_VALUE_OUT_OF_RANGE");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) throw new Error("EXPOSURE_OVERFLOW");
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function checkedExposure(edges: readonly StateEdge[]): bigint {
  let total = 0n;
  for (const edge of edges) {
    total += edge.amount;
    if (total > U64_MAX) throw new Error("EXPOSURE_OVERFLOW");
  }
  return total;
}

function assertU64(value: bigint, name: string): void {
  if (value < 0n || value > U64_MAX) throw new Error(`${name}_OUT_OF_RANGE`);
}

/**
 * Pure mirror of ADR-0017's authoritative on-chain allocation rule.
 * Claims must already be the reconciliation result's unique eligible edges.
 */
export function allocateDeterministicCoverage(
  claims: readonly ReconciledClaim[],
  collateralCoverageCap: bigint,
): DeterministicCoverageResult {
  assertU64(collateralCoverageCap, "COLLATERAL_COVERAGE_CAP");
  const ordered = [...claims].sort((left, right) => compareBytes(left.edge.credentialHash, right.edge.credentialHash));
  const seen = new Set<string>();
  let aggregateOfflineExposure = 0n;
  for (const claim of ordered) {
    assertU64(claim.edge.amount, "CLAIM_AMOUNT");
    if (claim.edge.amount === 0n) throw new Error("CLAIM_AMOUNT_OUT_OF_RANGE");
    const identity = hex(claim.edge.credentialHash);
    if (seen.has(identity)) throw new Error("DUPLICATE_ALLOCATION_EDGE");
    seen.add(identity);
    aggregateOfflineExposure += claim.edge.amount;
    if (aggregateOfflineExposure > U64_MAX) throw new Error("EXPOSURE_OVERFLOW");
  }

  const coverage = aggregateOfflineExposure < collateralCoverageCap
    ? aggregateOfflineExposure
    : collateralCoverageCap;
  if (aggregateOfflineExposure === 0n) {
    return {
      aggregateOfflineExposure,
      collateralCoverageCap,
      coverage,
      baseAllocationTotal: 0n,
      dustUnits: 0n,
      totalPayout: 0n,
      insolvent: false,
      allocations: [],
    };
  }

  const bases = ordered.map((claim) => claim.edge.amount * coverage / aggregateOfflineExposure);
  const baseAllocationTotal = bases.reduce((total, value) => total + value, 0n);
  const dustUnits = coverage - baseAllocationTotal;
  if (dustUnits < 0n || dustUnits > BigInt(ordered.length)) throw new Error("INVALID_DUST_REMAINDER");

  const allocations = ordered.map((claim, index): CoverageAllocation => {
    const baseAllocation = bases[index] ?? 0n;
    const dust = BigInt(index) < dustUnits ? 1n : 0n;
    const payout = baseAllocation + dust;
    if (payout > claim.edge.amount) throw new Error("ALLOCATION_EXCEEDS_CLAIM");
    return {
      credentialHash: claim.edge.credentialHash,
      merchant: claim.edge.merchant,
      amount: claim.edge.amount,
      baseAllocation,
      dust,
      payout,
    };
  });
  const totalPayout = allocations.reduce((total, allocation) => total + allocation.payout, 0n);
  if (totalPayout !== coverage || totalPayout > collateralCoverageCap) {
    throw new Error("COVERAGE_INVARIANT_VIOLATION");
  }

  return {
    aggregateOfflineExposure,
    collateralCoverageCap,
    coverage,
    baseAllocationTotal,
    dustUnits,
    totalPayout,
    insolvent: aggregateOfflineExposure > collateralCoverageCap,
    allocations,
  };
}

function conflictingChildHashes(graph: StateGraph): ReadonlySet<string> {
  const conflicting = new Set<string>();
  for (const fork of graph.forks) {
    for (const child of fork.childStateHashes) conflicting.add(hex(child));
  }

  // Edges are topologically ordered, but the fixed-point form keeps this
  // correct if the graph representation changes while remaining a DAG.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      const child = hex(edge.childStateHash);
      if (conflicting.has(child) || !conflicting.has(hex(edge.parentStateHash))) continue;
      conflicting.add(child);
      changed = true;
    }
  }
  return conflicting;
}

export function stateGraphCommitment(graph: StateGraph): Uint8Array {
  const parts: Uint8Array[] = [
    GRAPH_COMMITMENT_PREFIX,
    graph.sessionId,
    graph.genesis.stateHash,
    u32(graph.edges.length),
  ];
  for (const edge of graph.edges) {
    parts.push(
      edge.credentialHash,
      edge.parentStateHash,
      u32(edge.sequence),
      edge.childStateHash,
      edge.merchant,
      u64(edge.amount),
    );
  }
  return hashSha256(concat(parts));
}

export function reconcileSession(input: BuildStateGraphInput): ReconciliationResult {
  const stateGraph = buildStateGraph(input);
  const conflictingChildren = conflictingChildHashes(stateGraph);
  const eligibleClaims = stateGraph.edges.map((edge): ReconciledClaim => ({
    edge,
    classification: conflictingChildren.has(hex(edge.childStateHash)) ? "CONFLICTING" : "VALID",
  }));
  const validClaims = eligibleClaims.filter((claim) => claim.classification === "VALID");
  const conflictingClaims = eligibleClaims.filter((claim) => claim.classification === "CONFLICTING");

  return {
    sessionId: stateGraph.sessionId,
    stateGraph,
    eligibleClaims,
    validClaims,
    conflictingClaims,
    invalidCredentials: stateGraph.invalidCredentials,
    duplicateCredentials: stateGraph.duplicateCredentials,
    forks: stateGraph.forks,
    aggregateOfflineExposure: checkedExposure(stateGraph.edges),
    conflictingExposure: checkedExposure(conflictingClaims.map((claim) => claim.edge)),
    stateGraphCommitment: stateGraphCommitment(stateGraph),
  };
}

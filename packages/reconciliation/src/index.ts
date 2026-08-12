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

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

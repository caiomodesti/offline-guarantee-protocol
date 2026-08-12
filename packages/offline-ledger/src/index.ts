import {
  createGenesisState as createCryptographicGenesisState,
  createPaymentCredential,
  credentialHash,
  genesisStateHash,
  validateCertificateChain,
  validatePaymentCredential,
  verifySessionCertificate,
  type ParentState,
  type PaymentRequest,
} from "@ogp/credentials";
import {
  ObjectType,
  OgpValidationError,
  equalBytes,
  type DeviceAuthorization,
  type GenesisState,
  type PaymentCredential,
  type ProtocolTrustContext,
  type SessionCertificate,
} from "@ogp/shared-types";

export type DuplicateReason = "DUPLICATE_CREDENTIAL" | "DUPLICATE_STATE_EDGE";

export interface LedgerGenesis extends ParentState {
  readonly state: GenesisState;
}

export interface StateNode extends ParentState {
  readonly incomingCredentialHash: Uint8Array | null;
}

export interface StateEdge {
  readonly credential: PaymentCredential;
  readonly credentialHash: Uint8Array;
  readonly parentStateHash: Uint8Array;
  readonly childStateHash: Uint8Array;
  readonly sequence: number;
  readonly merchant: Uint8Array;
  readonly amount: bigint;
}

export interface RejectedCredential {
  readonly credential: PaymentCredential;
  readonly credentialHash: Uint8Array | null;
  readonly reason: string;
}

export interface DuplicateCredential {
  readonly credential: PaymentCredential;
  readonly credentialHash: Uint8Array;
  readonly canonicalCredentialHash: Uint8Array;
  readonly reason: DuplicateReason;
}

export interface ForkPoint {
  readonly sessionId: Uint8Array;
  readonly parentStateHash: Uint8Array;
  readonly sequence: number;
  readonly childStateHashes: readonly Uint8Array[];
  readonly credentialHashes: readonly Uint8Array[];
  readonly branchCount: number;
}

export interface StateGraph {
  readonly sessionId: Uint8Array;
  readonly genesis: LedgerGenesis;
  readonly nodes: readonly StateNode[];
  readonly edges: readonly StateEdge[];
  readonly invalidCredentials: readonly RejectedCredential[];
  readonly duplicateCredentials: readonly DuplicateCredential[];
  readonly forks: readonly ForkPoint[];
}

export interface BuildStateGraphInput {
  readonly context: ProtocolTrustContext;
  readonly sessionCertificate: SessionCertificate;
  readonly deviceAuthorization: DeviceAuthorization;
  readonly credentials: readonly PaymentCredential[];
}

export interface VerifiedTransition {
  readonly edge: StateEdge;
  readonly nextState: StateNode;
}

interface IndexedCredential {
  readonly credential: PaymentCredential;
  readonly credentialHash: Uint8Array;
  readonly credentialHashHex: string;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string {
  return error instanceof OgpValidationError ? error.code : "INVALID_CREDENTIAL";
}

function diagnosticCredentialKey(credential: PaymentCredential): string {
  const byteFields = [credential.domain.sessionId, credential.sessionId, credential.payer, credential.payerDeviceKey, credential.merchant, credential.merchantDeviceKey, credential.previousStateHash, credential.newStateHash, credential.merchantChallenge, credential.payerSignature];
  return [credential.domain.protocolVersion, credential.domain.schemaVersion, credential.domain.objectType, credential.domain.networkId, credential.sequence, credential.amount.toString(), credential.previousRemaining.toString(), credential.newRemaining.toString(), credential.createdAt.toString(), credential.sessionExpiresAt.toString(), ...byteFields.map(bytesToHex)].join(":");
}

function assertCertificateContext(context: ProtocolTrustContext, certificate: SessionCertificate): void {
  const domain = certificate.domain;
  if (
    domain.objectType !== ObjectType.SessionCertificate ||
    domain.networkId !== context.networkId ||
    !equalBytes(domain.clusterGenesisHash, context.clusterGenesisHash) ||
    !equalBytes(domain.programId, context.programId) ||
    !equalBytes(domain.sessionId, context.sessionId) ||
    !equalBytes(certificate.sessionId, context.sessionId)
  ) {
    throw new OgpValidationError("DOMAIN_MISMATCH", "certificate differs from the configured ledger domain");
  }
  if (!equalBytes(certificate.issuer, context.trustedCertificateIssuer)) {
    throw new OgpValidationError("UNTRUSTED_ISSUER", "certificate issuer is not the configured trust root");
  }
  if (!verifySessionCertificate(certificate)) {
    throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate signature is invalid");
  }
}

export function createGenesisState(context: ProtocolTrustContext, certificate: SessionCertificate): LedgerGenesis {
  assertCertificateContext(context, certificate);
  const state = createCryptographicGenesisState(context, {
    owner: certificate.owner,
    devicePublicKey: certificate.devicePublicKey,
    branchSpendingLimit: certificate.branchSpendingLimit,
    maxBranchDepth: certificate.maxBranchDepth,
    initialRemaining: certificate.branchSpendingLimit,
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
  });
  const stateHash = genesisStateHash(state);
  if (!equalBytes(stateHash, certificate.genesisStateHash)) {
    throw new OgpValidationError("INVALID_SESSION_CERTIFICATE", "certificate commits to another genesis state");
  }
  return { state, stateHash, sequence: 0, remaining: certificate.branchSpendingLimit };
}

export function applyPayment(
  context: ProtocolTrustContext,
  certificate: SessionCertificate,
  parent: ParentState,
  request: PaymentRequest,
  payerDeviceSecretKey: Uint8Array,
): PaymentCredential {
  return createPaymentCredential(context, certificate, parent, request, payerDeviceSecretKey);
}

export function verifyStateTransition(
  context: ProtocolTrustContext,
  certificate: SessionCertificate,
  parent: ParentState,
  credential: PaymentCredential,
): VerifiedTransition {
  if (parent.sequence > certificate.maxBranchDepth || parent.remaining > certificate.branchSpendingLimit) {
    throw new OgpValidationError("INVALID_PARENT", "parent state exceeds the certificate bounds");
  }
  validatePaymentCredential(context, certificate, parent, credential);
  const hash = credentialHash(credential);
  const edge: StateEdge = {
    credential,
    credentialHash: hash,
    parentStateHash: credential.previousStateHash,
    childStateHash: credential.newStateHash,
    sequence: credential.sequence,
    merchant: credential.merchant,
    amount: credential.amount,
  };
  return {
    edge,
    nextState: {
      stateHash: credential.newStateHash,
      sequence: credential.sequence,
      remaining: credential.newRemaining,
      incomingCredentialHash: hash,
    },
  };
}

function edgeIdentity(edge: StateEdge): string {
  return `${bytesToHex(edge.parentStateHash)}:${edge.sequence}:${bytesToHex(edge.childStateHash)}`;
}

function forkKey(edge: StateEdge): string {
  return `${bytesToHex(edge.parentStateHash)}:${edge.sequence}`;
}

function detectForksFromVerifiedEdges(sessionId: Uint8Array, edges: readonly StateEdge[]): readonly ForkPoint[] {
  const groups = new Map<string, StateEdge[]>();
  for (const edge of edges) {
    const key = forkKey(edge);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [edge]);
    else group.push(edge);
  }

  const forks: ForkPoint[] = [];
  for (const group of groups.values()) {
    const uniqueChildren = new Map<string, StateEdge>();
    for (const edge of group) uniqueChildren.set(bytesToHex(edge.childStateHash), edge);
    if (uniqueChildren.size <= 1) continue;
    const branches = [...uniqueChildren.values()].sort((left, right) => compareBytes(left.childStateHash, right.childStateHash));
    const first = branches[0];
    if (first === undefined) continue;
    forks.push({
      sessionId,
      parentStateHash: first.parentStateHash,
      sequence: first.sequence,
      childStateHashes: branches.map((edge) => edge.childStateHash),
      credentialHashes: branches.map((edge) => edge.credentialHash),
      branchCount: branches.length,
    });
  }
  return forks.sort((left, right) => compareBytes(left.parentStateHash, right.parentStateHash) || left.sequence - right.sequence);
}

export function detectForks(graph: Pick<StateGraph, "sessionId" | "edges">): readonly ForkPoint[] {
  return detectForksFromVerifiedEdges(graph.sessionId, graph.edges);
}

export function buildStateGraph(input: BuildStateGraphInput): StateGraph {
  validateCertificateChain(input.context, input.sessionCertificate, input.deviceAuthorization);
  const genesis = createGenesisState(input.context, input.sessionCertificate);

  const exactRepresentatives = new Map<string, IndexedCredential>();
  const duplicateCredentials: DuplicateCredential[] = [];
  const invalidCredentials: RejectedCredential[] = [];
  const malformedSortKeys = new Map<RejectedCredential, string>();
  for (const credential of input.credentials) {
    let hash: Uint8Array;
    try {
      hash = credentialHash(credential);
    } catch (error) {
      const rejected = { credential, credentialHash: null, reason: errorCode(error) } satisfies RejectedCredential;
      invalidCredentials.push(rejected);
      malformedSortKeys.set(rejected, diagnosticCredentialKey(credential));
      continue;
    }
    const hashHex = bytesToHex(hash);
    const existing = exactRepresentatives.get(hashHex);
    if (existing !== undefined) {
      duplicateCredentials.push({ credential, credentialHash: hash, canonicalCredentialHash: existing.credentialHash, reason: "DUPLICATE_CREDENTIAL" });
    } else {
      exactRepresentatives.set(hashHex, { credential, credentialHash: hash, credentialHashHex: hashHex });
    }
  }

  let pending = [...exactRepresentatives.values()].sort((left, right) => compareText(left.credentialHashHex, right.credentialHashHex));
  const nodesByHash = new Map<string, StateNode>();
  nodesByHash.set(bytesToHex(genesis.stateHash), { stateHash: genesis.stateHash, sequence: 0, remaining: genesis.remaining, incomingCredentialHash: null });
  const acceptedEdgesByIdentity = new Map<string, StateEdge>();
  const edges: StateEdge[] = [];

  while (pending.length > 0) {
    let progressed = false;
    const nextPending: IndexedCredential[] = [];
    for (const entry of pending) {
      const parent = nodesByHash.get(bytesToHex(entry.credential.previousStateHash));
      if (parent === undefined) {
        nextPending.push(entry);
        continue;
      }
      progressed = true;
      try {
        const transition = verifyStateTransition(input.context, input.sessionCertificate, parent, entry.credential);
        const identity = edgeIdentity(transition.edge);
        const equivalentEdge = acceptedEdgesByIdentity.get(identity);
        if (equivalentEdge !== undefined) {
          duplicateCredentials.push({ credential: entry.credential, credentialHash: entry.credentialHash, canonicalCredentialHash: equivalentEdge.credentialHash, reason: "DUPLICATE_STATE_EDGE" });
          continue;
        }
        const childHashHex = bytesToHex(transition.nextState.stateHash);
        if (nodesByHash.has(childHashHex)) {
          invalidCredentials.push({ credential: entry.credential, credentialHash: entry.credentialHash, reason: "STATE_HASH_COLLISION" });
          continue;
        }
        acceptedEdgesByIdentity.set(identity, transition.edge);
        edges.push(transition.edge);
        nodesByHash.set(childHashHex, transition.nextState);
      } catch (error) {
        invalidCredentials.push({ credential: entry.credential, credentialHash: entry.credentialHash, reason: errorCode(error) });
      }
    }
    if (!progressed) {
      for (const entry of nextPending) invalidCredentials.push({ credential: entry.credential, credentialHash: entry.credentialHash, reason: "INVALID_PARENT" });
      pending = [];
    } else {
      pending = nextPending;
    }
  }

  edges.sort((left, right) => left.sequence - right.sequence || compareBytes(left.parentStateHash, right.parentStateHash) || compareBytes(left.childStateHash, right.childStateHash) || compareBytes(left.credentialHash, right.credentialHash));
  const nodes = [...nodesByHash.values()].sort((left, right) => left.sequence - right.sequence || compareBytes(left.stateHash, right.stateHash));
  invalidCredentials.sort((left, right) => {
    if (left.credentialHash !== null && right.credentialHash !== null) return compareBytes(left.credentialHash, right.credentialHash) || compareText(left.reason, right.reason);
    if (left.credentialHash !== null) return -1;
    if (right.credentialHash !== null) return 1;
    return compareText(malformedSortKeys.get(left) ?? "", malformedSortKeys.get(right) ?? "") || compareText(left.reason, right.reason);
  });
  duplicateCredentials.sort((left, right) => compareText(left.reason, right.reason) || compareBytes(left.credentialHash, right.credentialHash));
  return {
    sessionId: input.sessionCertificate.sessionId,
    genesis,
    nodes,
    edges,
    invalidCredentials,
    duplicateCredentials,
    forks: detectForksFromVerifiedEdges(input.sessionCertificate.sessionId, edges),
  };
}

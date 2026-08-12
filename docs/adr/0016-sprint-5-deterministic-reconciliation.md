# ADR-0016: Sprint 5 deterministic reconciliation boundary

- Status: Accepted for MVP
- Date: 2026-08-12

## Context

The Prompt Master assigns DAG reconstruction, fork detection, valid-claim classification, conflict classification, and exposure calculation to Sprint 5. Sprint 6 owns collateral coverage, merchant settlement, conflicted-session state, and revocation. ADR-0001 also forbids trusting a reconciliation authority, while ADR-0005 requires critical finalization and allocations to remain program-verifiable.

## Decision

Sprint 5 adds `@ogp/reconciliation` as a deterministic, authority-free explanatory engine over the cryptographically authenticated graph from `@ogp/offline-ledger`.

It produces unique eligible economic edges; `VALID` common-prefix claims; `CONFLICTING` fork siblings and descendants; formal fork points including triple forks; aggregate and conflicting exposure using integer arithmetic; and a 32-byte binary state-graph commitment independent of arrival order.

Conflict propagation begins at every distinct authenticated child of a fork key and includes all reachable descendants. The common prefix remains `VALID`. Aggregate exposure sums every unique reachable edge once: shared prefixes once and incompatible branch edges separately.

The commitment is SHA-256 over the fixed prefix `OGP:STATE_GRAPH:V1\0`, session ID, genesis hash, edge count, and the canonically sorted edge sequence. Each edge contributes representative credential hash, parent hash, little-endian sequence, child hash, merchant, and little-endian amount. JSON, timestamps, arrival position, merchant labels, and branch names are excluded.

This engine is not an economic authority. Until Sprint 6 independently verifies fork evidence and performs the already specified atomic conflict/revocation transition, its double-spend result is only `PROVISIONAL DETECTION`. Sprint 5 emits no authoritative `AuthenticatedForkConfirmed`, `SessionMarkedConflicted`, coverage, settlement, or revocation event.

## Consequences

- The same authenticated evidence produces the same graph, classifications, exposure, and commitment under every arrival permutation.
- Invalid, unreachable, replayed, or economically duplicate evidence cannot increase exposure or create a fork.
- The engine can drive reconstruction, indexing, tests, and future witness creation without a trusted reconciliation key.
- On-chain frozen-set completeness, authoritative conflict confirmation, allocation, settlement, and revocation remain required Sprint 6 work; the off-chain commitment alone can never move value.

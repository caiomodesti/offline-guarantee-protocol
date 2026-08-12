# Sprint 2 — Offline Ledger

Status: **COMPLETE FOR DEFINED SCOPE; Sprint 3 NOT STARTED**

## Outcome

Sprint 2 implements the portable offline state ledger in `@ogp/offline-ledger`. It consumes only the trusted cryptographic objects produced by Sprint 1 and reconstructs a deterministic authenticated DAG without using arrival order or offline timestamps as branch priority.

Implemented master-plan APIs:

| API | Result |
|---|---|
| `createGenesisState()` | Reconstructs H0 from immutable certificate fields and requires the exact committed genesis hash |
| `applyPayment()` | Applies checked payment arithmetic through the Sprint 1 credential state machine |
| `verifyStateTransition()` | Verifies domain, issuer, signature, parent, sequence, arithmetic, hash, depth, and time-metadata consistency |
| `buildStateGraph()` | Reconstructs all valid reachable branches independent of input order; separates invalid and duplicate evidence |
| `detectForks()` | Returns fork points only from the graph's verified reachable edges |

The graph contains canonical sorted nodes, edges, invalid credentials, duplicate credentials, and fork points. Descendants can arrive before parents; iterative topological reconstruction resolves them when the parent becomes reachable. Credentials whose parents never become reachable receive `INVALID_PARENT` and cannot form a fork.

## Deterministic classification

| Evidence | Ledger classification | Economic edge count | Fork effect |
|---|---|---:|---|
| Exact same credential bytes/hash twice | `DUPLICATE_CREDENTIAL` | 1 | None |
| Different valid wrappers, identical state edge | `DUPLICATE_STATE_EDGE` | 1 | None |
| Valid siblings, distinct child hashes | Valid edges | One per child | Fork when child count >1 |
| Invalid signature/transition/domain | Invalid with stable reason | 0 | None |
| Valid signature but unreachable parent | `INVALID_PARENT` | 0 | None |
| Three distinct valid children | Valid edges | 3 | One fork point with `branchCount = 3` |

All canonical representatives, nodes, edges, and forks are ordered by unsigned byte order and numeric sequence. `created_at`, credential arrival position, merchant name, and branch label never select a canonical branch.

## Material design correction discovered in Sprint 2

The hostile audit disproved an earlier assumption: distinct credential bytes with the same `new_state_hash` do not necessarily imply a SHA-256 collision. `created_at` and `merchant_device_key` are authenticated by `PaymentCredential` but deliberately excluded from `PaymentState`; changing only such metadata produces a new `credential_hash` for the same economic transition.

If idempotency used only `credential_hash`, one payment state could be allocated twice. The correction is formalized in [ADR-0011](adr/0011-economic-state-edge-idempotency.md):

```text
exact wrapper identity = credential_hash
economic identity = (session, parent_hash, sequence, child_hash)
```

The smallest valid credential hash deterministically represents an economic edge. Coverage counts the edge once. Sprint 4 must add a compact `StateEdgeRecord` alongside credential-hash claim PDAs; this Sprint does not create on-chain accounts early.

## Acceptance evidence

Sprint 2 adds 11 tests. Together with Sprint 1, the TypeScript suite now has 25 passing tests.

Coverage includes:

- certificate-committed H0;
- valid `H0 -> H1 -> H2` with `[H2, H1]` arrival order;
- identical replay without fork;
- simple fork and triple fork;
- invalid sibling excluded from fork cardinality;
- two sequence-2 edges with different parents not misclassified as siblings;
- metadata-distinct wrappers for one child becoming `DUPLICATE_STATE_EDGE`;
- missing parent becoming `INVALID_PARENT`;
- malformed signature length classified without aborting the graph;
- 32 property-generated input permutations producing an identical graph digest;
- direct transition mutation rejection.

Master acceptance criteria:

| Criterion | Status | Evidence |
|---|---|---|
| `H0 -> H1 -> H2` is valid | PASS | Two reachable edges, three nodes, no invalid/duplicate/fork |
| `H1 -> H2A` and `H1 -> H2B` produces `forkDetected = true` | PASS | One fork point, same parent/sequence, two distinct verified children |

## Hostile self-audit

### Fixed: economic replay through metadata-only wrapper changes — Critical

`credential_hash` alone could multiply one state edge. `DUPLICATE_STATE_EDGE`, deterministic representative selection, and ADR-0011 close the portable-ledger failure. The future on-chain mitigation is now an explicit Sprint 4 requirement.

### Fixed: malformed credential could abort the entire reconstruction — High

Initial graph indexing computed every credential hash without an error boundary. A structurally malformed wrapper could throw before valid siblings were processed. Malformed canonical bytes are now isolated as invalid evidence with a null canonical hash; valid graph reconstruction continues.

### Fixed: public fork detector could imply it accepted arbitrary edges — Medium

`detectForks()` now accepts a graph-shaped object and processes its verified edge set. `buildStateGraph()` remains the security boundary that authenticates reachability; raw credentials are never counted directly.

### Verified: arrival order cannot change results

Credentials are hashed, deduplicated, sorted, and then reconstructed topologically. Fork children and graph output are byte-sorted. Property tests permute normal, conflicting, descendant, and replay inputs and require the exact same digest.

## Known limitations and open risks

| Limitation | Consequence | Future owner |
|---|---|---|
| Ledger is in-memory and receives decoded typed objects | Persistence corruption and transport framing are not solved | Sprint 7 QR/mobile storage |
| Complete parent evidence is required | Missing branch prefixes are rejected even if a descendant signature is valid | Intentional MVP reachability rule |
| Depth is capped at 32, but branch count is not yet economically/rent bounded | A compromised device can create claim-spam branches | Sprint 4 benchmarks and claim fee/account policy |
| Smallest-hash representative permits metadata grinding | Cannot multiply amount, but can affect deterministic dust priority later | Accepted bounded risk; Sprint 6 tests |
| Full DAG/exposure/coverage calculation is absent | Ledger detects structure but makes no settlement recommendation | Sprint 5 and Sprint 6 |
| No on-chain verification exists | `FORK DETECTED` remains unavailable as authoritative demo state | Sprint 4–6 |
| SHA-256 collision | Could alias distinct state payloads | Accepted computationally infeasible open risk |

## Reproduction

```shell
pnpm install --frozen-lockfile
pnpm run test:ts
pnpm run check
```

`test:ts` compiles all packages and runs both crypto and offline-ledger tests. `check` additionally verifies the six golden vectors and independent Rust conformance harness.

## Files changed in Sprint 2

Implementation and workspace:

- `packages/offline-ledger/package.json`
- `packages/offline-ledger/tsconfig.json`
- `packages/offline-ledger/src/index.ts`
- `tests/offline-ledger/ledger.test.ts`
- `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vitest.config.ts`
- `.superstack/build-context.md`

Protocol documentation:

- `README.md`
- `docs/protocol.md`
- `docs/cryptography.md`
- `docs/architecture.md`
- `docs/product-spec.md`
- `docs/threat-model.md`
- `docs/requirements-traceability.md`
- `docs/sprint-0-audit.md`
- `docs/sprint-2-report.md`
- `docs/adr/0005-claim-storage-and-finalization.md`
- `docs/adr/0008-pdas-custody-and-concurrency.md`
- `docs/adr/0011-economic-state-edge-idempotency.md`
- `docs/adr/README.md`

## Stop condition

Sprint 2 satisfies both acceptance criteria and its hostile audit. No `programs/` directory, Anchor dependency, PDA account, SPL token instruction, reconciliation engine, economic allocation, mobile app, or dashboard was created. Sprint 3 requires explicit review/continuation.


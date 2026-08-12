# Sprint 5 — Reconciliation

Status: **PASS — HOST RECONCILIATION CORE**

Scope boundary: deterministic reconstruction/classification only; stopped before Sprint 6 economic resolution

## Outcome

Sprint 5 implements the independent reconciliation engine required by the Prompt Master. It consumes only authenticated certificate, authorization, and credential evidence; rebuilds the reachable DAG; excludes invalid and duplicate evidence; detects simple and triple forks; classifies common-prefix versus conflicting branch claims; calculates unique aggregate exposure; and commits to the result with canonical binary hashing.

It does not calculate coverage, allocate collateral, settle merchants, change the on-chain session to `CONFLICTED`, revoke the payer, release collateral, or emit any authoritative attack-demo event reserved for Sprint 6.

## Deterministic result

`reconcileSession()` returns the state graph, eligible/valid/conflicting claims, invalid and duplicate credentials, forks, aggregate/conflicting exposure, and `stateGraphCommitment`.

`aggregateOfflineExposure` sums each unique reachable economic edge once. Shared prefixes count once; distinct valid branches count separately. `conflictingExposure` begins at the sibling edges of each authenticated fork and includes all their descendants. No offline timestamp or arrival order influences either value.

## Acceptance matrix

| Requirement | Evidence | Result |
|---|---|---|
| DAG reconstruction | Existing authenticated topological ledger consumed directly | PASS |
| Normal branch | Two-edge chain remains `VALID` | PASS |
| Simple fork | Siblings and descendants become `CONFLICTING`; prefix remains `VALID` | PASS |
| Triple fork | Three unique child hashes produce one three-branch fork point | PASS |
| Invalid branch | Bad signature excluded from graph, fork, and exposure | PASS |
| Replay protection | Exact replay excluded from economic edge count | PASS |
| Economic idempotency | Different wrapper/same state edge counted once | PASS |
| Exposure calculation | Integer unique-edge sums for aggregate/conflicting exposure | PASS |
| Arrival independence | Property-based permutations preserve result and commitment | PASS |
| Graph commitment | Fixed binary schema and SHA-256, no JSON/timestamps/order metadata | PASS |
| Economic boundary | No coverage, allocation, payout, revocation, release, or withdrawal | PASS |

## Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
cargo fmt --manifest-path programs/offline-guarantee/Cargo.toml -- --check
cargo clippy --manifest-path programs/offline-guarantee/Cargo.toml --all-targets -- -D warnings
```

The Solana program and its accepted SBF artifact are unchanged from Sprint 4. Sprint 5 is a host-side reconstruction engine by schedule; it cannot mutate authoritative protocol state. Sprint 6 must add validator-backed witness/finalization and economic transitions before any authoritative demo incident message becomes available.

Clean Linux acceptance [run 31618585829](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31618585829) passed the 34 TypeScript tests, six golden vectors, Rust conformance, 14 program tests, real SBF rebuild, and the complete 23-assertion validator regression suite at commit `8c8394d`.

## Hostile audit

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| Critical | Trivial if trusted economically | Reconciler cannot move value by assertion | Host can invent a result object | No Sprint 5 output is accepted as economic authority; Sprint 6 must reverify critical predicates | MITIGATED BY BOUNDARY |
| High | Practical | Invalid evidence cannot fabricate conflict | Bad signature/unreachable parent cases | Authentication and reachability occur before fork grouping | PASS |
| High | Practical | Duplicate wrappers cannot multiply exposure | Credential bytes may differ while state edge is identical | Economic state-edge identity and deterministic representative | PASS |
| High | Practical | Arrival order cannot choose legitimacy | Input permutations and descendants-before-parent | Canonical credential/edge sorting plus property tests | PASS |
| Medium | Practical | Conflict must include branch descendants | Naive sibling-only classification understates exposure | Fixed-point propagation from every fork child | PASS |
| Medium | Operational | Commitment schema must not be ambiguous | Arbitrary JSON would permit alternate encodings | Fixed prefix, widths, endian rules, field order, SHA-256 | PASS |
| Medium | Liveness | Full evidence can be withheld | Merchant/reconstructor storage remains required | Permissionless relay and multiple evidence holders; durable storage deferred | OPEN RISK |
| Medium | Scale | Fork spam can enlarge reconstruction work | Compromised device may sign many branches | Depth bounded at 32; claim rent/on-chain serialization; batching/compression deferred | OPEN RISK |
| Low | Theoretical | State hash collision could merge distinct states | SHA-256 collision | Collision rejected when distinct accepted states share a child hash; cryptographic assumption remains | ACCEPTED MVP RISK |

## Files changed

- `packages/reconciliation/*`
- `tests/reconciliation/reconciliation.test.ts`
- `docs/adr/0016-sprint-5-deterministic-reconciliation.md`
- `docs/sprint-5-report.md`
- root workspace manifests and build context

## Sprint boundary

Sprint 5 is complete at the deterministic host-engine layer defined by the original schedule. Sprint 6 has not started. Before Sprint 6 can be accepted, fork witnesses, frozen-set completeness, conflict/revocation atomicity, coverage/allocation, SPL settlement, reserve release, and runtime rollback must all be proven in SBF/validator execution.

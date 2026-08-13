# Sprint 6 — Economic Resolution Report

Date: 2026-08-13  
Source of truth: original Prompt Master, Sprint 6 only  
Scope boundary: collateral coverage, merchant settlement, conflicted session, revocation, close, and formally safe collateral withdrawal  
Sprint 7 status: not started

## Outcome

Implementation is complete at the host-check level. Final PASS/NO-GO remains gated on the clean Linux SBF and two-phase validator run recorded below. The program contains no test clock bypass: the runtime suite persists the ledger, restarts `solana-test-validator` with a future `--warp-slot`, and then exercises the real six-hour claim deadline.

## Implemented protocol behavior

| Requirement | Authoritative implementation |
|---|---|
| Fork confirmation | `ForkRecord` PDA counts distinct verified children for exact `(session, parent, sequence)` |
| Conflict and revocation | Second child atomically sets sticky fork, session conflict, profile revocation, timestamp, and events |
| Historical claims after revocation | Timely claims remain accepted for the conflicted session through its deadline |
| Frozen set | Permissionless `begin_finalization` only when Solana Clock is strictly after the deadline |
| Completeness | Frozen edge count/exposure plus a program-validated hash-ordered wrapper list |
| Conflict propagation | Topological edge classification from final fork records and already-classified parents |
| Full coverage | Every representative receives face value when `T <= C` |
| Insolvency | Checked `u128` pro-rata base plus dust to ascending representative hashes when `T > C` |
| Liability | Completion requires `sum(allocation) = min(T, C)`; never exceeds the derived cap |
| Settlement | Classic SPL `transfer_checked`, signed only by vault PDA, to signed merchant's token account |
| Replay | Claim and edge settlement state make a second payout fail |
| Reserve release | Full cap until finalization; then exactly unpaid allocations; zero after settlement |
| Withdrawal | Owner may withdraw only the minimum of book and real SPL availability above reserve |

## Deterministic finalization

The implementation follows ADR-0003, ADR-0005, ADR-0009, ADR-0010, ADR-0011, and ADR-0017:

```text
claim accepted       iff Clock <= claim_submission_deadline
finalization starts  iff Clock >  claim_submission_deadline

coverage = min(frozen_exposure, collateral_coverage_cap)
base_i = floor(amount_i * coverage / frozen_exposure)
remainder = coverage - sum(base_i)
allocation_i = base_i + 1 for the first remainder representative hashes
```

Arrival order, `created_at`, submitted slot, merchant identity, and branch label do not determine priority. All authenticated conflicting branches remain eligible. Duplicate wrappers are traversed for completeness but receive no economic allocation.

## Demo contract

No required message depends only on dashboard memory.

| Message | Evidence | Protocol state change | Authoritative event | Frontend source |
|---|---|---|---|---|
| `DOUBLE SPEND ATTEMPTED` | Second unique verified child for the same session/parent/sequence | Fork child count becomes 2; conflict transaction begins atomically | `ClaimSubmitted` plus `AuthenticatedForkConfirmed` in the same transaction | Decode transaction events and fetch the matching `ForkRecord`; it may label earlier off-chain comparison only as provisional |
| `FORK DETECTED` | Program confirms two distinct valid child hashes | Sticky `authenticated_fork=true`, session `CONFLICTED` | `AuthenticatedForkConfirmed`, `SessionMarkedConflicted` | Subscribe/index events, then fetch session and fork PDA |
| `COLLATERAL COVERS CLAIMS` | Frozen counters and allocation sum satisfy `T <= C` | `coverage_status=FULLY_COVERED`; reserve becomes unpaid allocation total | `CoverageCalculated`, `CollateralCoverageApplied` | Decode events and fetch session/vault; never infer from local claim list alone |
| `OFFLINE ACCESS REVOKED` | Same authenticated fork confirmation | `offline_access_enabled=false`, `conflict_count += 1`, `revoked_at=Clock` | `OfflineAccessRevoked` | Decode event and fetch `UserProfile`; new-session failure is additional enforcement evidence |

## Host validation

```text
TypeScript/Vitest                 34 PASS
golden vectors                     6 PASS
canonical Rust conformance         1 PASS
program Rust tests                16 PASS
cargo fmt                          PASS
cargo clippy -D warnings           PASS
git diff --check                   PASS
```

The Rust tests include the official pro-rata example `65000 / 50000`, exact two-unit dust distribution, `u64::MAX` multiplication safety through `u128`, 300% collateral boundaries, deadline overflow, reservation accounting, and account-size freezes.

## SBF and validator evidence

Clean remote run: pending final accepted commit.

Pinned environment:

```text
Ubuntu 24.04
Rust 1.97.1
Solana/Agave 3.1.10
Anchor 1.0.2
Node 22.17.0
pnpm 11.16.0
```

Required runtime proofs:

- real SBF artifact and SHA-256;
- claim Ed25519 verification and PDA creation;
- authenticated fork plus atomic revocation;
- pre-deadline finalization rollback;
- persisted-ledger warp beyond the real claim deadline;
- frozen-set completeness and out-of-order rejection;
- verified conflict classification and duplicate-processing rollback;
- full coverage allocation `25 + 30 = 55` with cap `300`;
- reserve transition `300 -> 55` only after finalization;
- destination substitution and settlement replay rejection;
- two real PDA-signed SPL payouts and token/book equality;
- automatic conflicted-session close;
- withdrawal `246` rejected and exact available `245` accepted.

## Hostile audit

### Findings fixed during the sprint

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Practical wrapper reordering | One economic representative per edge | Smaller duplicate changed only edge hash, leaving wrong claim submitted | Atomic old/new claim status swap and adversarial runtime assertion | FIXED |
| High | Permissionless cursor poisoning | Frozen-set completeness | Caller-selected first hash could omit earlier claims | Program-validated ordered linked list with stored head/cursor/count | FIXED |
| High | Caller account substitution | Allocation/merchant binding | Claim could be paired with an unrelated session edge | Full merchant/amount/sequence/parent/child equality in allocation and settlement | FIXED |
| High | Early collateral release | Claim-window guarantee | Finalization before grace deadline would reduce reserve | Strict Solana Clock boundary; validator pre-deadline failure | FIXED |
| High | Settlement redirect/replay | Merchant payout | Relayer could try another token destination or repeat transfer | SPL owner/mint constraints plus claim/edge settled state | FIXED |
| High | SBF frame overwrite | Runtime memory safety | First SBF run emitted frame-overwrite diagnostics and decoded `254` instead of `25` | Heap-box large account/state values; CI now fails on any stack/undefined-behavior diagnostic | FIXED, FINAL SBF RECHECK REQUIRED |
| Medium | Descendant under-classification | Conflict accounting | Direct fork proof alone does not classify descendants | Frozen fork records plus topological parent conflict propagation | FIXED |
| Medium | Zero-allocation liveness | Session close | Zero allocation could never call settlement | Zero allocation is finalized as already settled | FIXED |
| Medium | Incomplete traversal terminal | Completeness | Count could finish with a non-sentinel next pointer after corruption | Completion also requires `next_allocation_claim=default` | FIXED |

### Remaining risks

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High for production | Upgrade-key compromise | All program guarantees | Dev key remains single authority | Multisig, audited upgrade/immutability plan before production | OPEN RISK |
| Medium | Claim/account spam | Availability and rent | One Claim plus edge/fork/list writes per submitted wrapper | Fees, bounded sessions, future admission/compression policy | OPEN RISK |
| Medium | Large ordered insertion | Relayer UX/compute | Caller must locate adjacent claim accounts | Indexer supplies witnesses; benchmark and compressed accumulator later | OPEN RISK |
| Medium | Mint freeze or malicious mint policy | Settlement availability | Classic SPL mint authority policy is not restricted yet | Controlled demo mint; production allowlist and authority checks | OPEN RISK |
| Low | Direct SPL donations become stranded | Owner recovery | Donations do not enter protocol book accounting | Explicit recovery/sweep governance deferred; never count donations as collateral | OPEN RISK |
| Low | Credential-hash grinding | Dust fairness | Earliest representative hashes receive at most one extra unit | Economic impact bounded to dust; stronger tie-break deferred | ACCEPTED MVP RISK |

## Acceptance gates

| Gate | Result |
|---|---|
| Host/conformance suite | PASS |
| SBF compilation | PENDING clean run |
| Validator collection/fork/revocation | PENDING clean run |
| Deadline warp/frozen set | PENDING clean run |
| Coverage/reserve transition | PENDING clean run |
| Real SPL settlement CPI | PENDING clean run |
| Withdrawal safety | PENDING clean run |
| Hostile audit | PASS with documented open risks |

## Decision

`PENDING — DO NOT START SPRINT 7` until every remote runtime gate above is green on the final audited commit.

# Sprint 0 hostile self-audit — OGP v0.1

Date: 2026-08-10  
Scope: official v0.1 decisions, economic model, state machines, fork proof, claim lifecycle, Solana responsibilities, cryptography, and demo contract.  
Conclusion: **Sprint 0 is internally deterministic and ready for owner review; unresolved risks block production, not specification review. Sprint 1 was not started.**

## Method

The design was attacked assuming:

- full payer-device compromise, rollback, cloning, and manipulated local clock;
- malicious payer, merchant, issuer, reconciler, relayer, indexer, or dashboard;
- adversarial claim ordering and interrupted finalization;
- hidden forks, triple forks, invalid fork branches, duplicates, and integer extremes;
- public-chain metadata collection;
- no trusted frontend or backend boolean.

Every critical requirement was traced to evidence, authority, state transition, event/output, trust assumption, threat, mitigation, and future test.

## Hostile findings resolved in this revision

### H-01: `CLAIM_WINDOW` cannot transition automatically with wall-clock time

Solana account data does not mutate merely because `expires_at` passes. Treating the state transition as automatic would make the state machine fictional.

**Resolution:** a permissionless phase-advance instruction, or the first step of any post-expiry instruction, materializes `ACTIVE -> CLAIM_WINDOW` from the on-chain clock.

### H-02: Conflict and reconciliation compete for one session enum

A conflicted session must later enter `RECONCILING`; a naïve enum transition would erase proof that it had conflicted.

**Resolution:** `authenticated_fork` is sticky and orthogonal. The session may move `CONFLICTED -> RECONCILING -> CONFLICTED/INSOLVENT -> CLOSED` without losing incident history. User revocation remains in `UserRiskProfile`.

### H-03: Coverage outcome would disappear after `CLOSED`

Using only `SessionStatus` could erase whether a closed session was fully covered or insolvent.

**Resolution:** persisted `CoverageStatus = UNCALCULATED | FULLY_COVERED | INSOLVENT` is separate from lifecycle state.

### H-04: `SETTLED` could be assigned before transfers

Coverage calculation alone is not settlement.

**Resolution:** a normal session stays `RECONCILING` until every transfer completes, then records `SETTLED`, and only then `CLOSED`. Conflicted/insolvent sessions remain labeled during payout and close only after allocations and residual locks resolve.

### H-05: Provisional double-spend messaging could be mistaken for protocol truth

The official design allows early off-chain detection, but the original demo contract required protocol-backed headlines.

**Resolution:** `DOUBLE SPEND ATTEMPTED` is derived only from the production canonical decoder/signature/transition verifier and is visibly labeled `PROVISIONAL DETECTION`; it changes no economic state. `FORK DETECTED` is forbidden until confirmed `AuthenticatedForkConfirmed` plus matching accounts.

### H-06: Certificate activation added unnecessary authority and liveness states

The prior specification introduced issuer-controlled activation and a timeout not required by official v0.1 decisions.

**Resolution:** `create_offline_session` creates authoritative `ACTIVE` state. The issuer only signs a portable finalized representation. On-chain claim verification rejects mismatches; issuer has no activation, custody, reconciliation, or revocation power.

### H-07: First-come settlement would violate official coverage policy

Paying during collection lets network ordering consume collateral before hidden claims arrive.

**Resolution:** claims enter `SUBMITTED`; settlement is impossible before the six-hour post-expiry claim deadline and permissionless finalization. All permutations of the same frozen eligible set must yield identical allocations.

### H-08: Pro-rata rounding needed exact conservation

Decimal ratios such as `500/650` cannot use floats and flooring each claim can leave dust.

**Resolution:** `base_i = floor(amount_i*C/T)` with checked `u128`; remaining minor units go to ascending credential hashes. Allocations sum exactly to `C`, never exceed claim amounts, and do not depend on arrival order.

### H-09: Trivial self-merchant attack lacked even the requested minimal control

**Resolution:** eligibility requires `payer_wallet != merchant_wallet` and returns `SELF_MERCHANT_FORBIDDEN` otherwise. Multiple controlled wallets remain an explicit open risk.

### H-10: Session lock could be confused with full vault balance

**Resolution:** only `collateral_locked` is reserved for the one active/claimable session. Example: vault `100000`, lock `50000`, no other encumbrance means `50000` remains withdrawable. Actual SPL balance and reservation sums are checked atomically.

## Earlier critical findings retained as resolved constraints

### R-01: Parent hash alone does not prove genesis reachability

The MVP retains a complete genesis-to-tip `CredentialProofBundle`, capped at depth 32. Every edge is verified; fabricated independent roots cannot become eligible or create a fork.

### R-02: An off-chain reconciler could omit claims

Compact claim PDAs maintain authoritative frozen counters. Paginated finalization uses strict credential-hash order, one-time inclusion flags, processed count/amount, and a rolling resolution commitment. Completion requires equality with frozen counters and is permissionlessly resumable.

### R-03: Expiry is not safe collateral release

The full unpaid coverage cap stays reserved through `claim_submission_deadline = expires_at + 6h` and finalization. Only unpaid allocations remain reserved afterward; residual collateral releases only when liability is resolved.

### R-04: Invalid garbage could frame a payer

Only individually canonical, correctly signed, domain-bound, transition-valid, reachable sibling credentials count. Exact replay, a distinct wrapper for the same child edge, or an invalid second branch cannot emit `AuthenticatedForkConfirmed` or revoke access. Sprint 2 formalized the distinct-wrapper case in ADR-0011 after demonstrating that metadata-only differences do not require a hash collision.

## Deterministic v0.1 rules

| Surface | Rule |
|---|---|
| Economic values | `collateral_locked` is reserved value; `branch_spending_limit` bounds each valid path; `collateral_coverage_cap` bounds total protocol payout and equals locked collateral in MVP |
| Eligible aggregate | Sum each unique eligible DAG edge once; common prefix/replay once; conflicting edges separately |
| Claim collection | Store compact `SUBMITTED` claims; no payout |
| Fork | Two or more individually valid reachable credentials with same session/parent/expected sequence and distinct child hashes |
| Replay | Same credential/child hash is duplicate, never fork |
| Invalid branch | `REJECTED`; never economic fork |
| Full coverage | `T <= C`, every eligible claim gets its full amount, status `FULLY_COVERED` |
| Insolvency | `T > C`, status `INSOLVENT`, deterministic pro-rata plus hash-ordered dust |
| Ordering | Arrival, submission slot, local timestamp, merchant identity, and branch labels never prioritize payout |
| Revocation | Atomic with on-chain authenticated-fork confirmation; new sessions fail; historical timely claims survive |
| Claim deadline | Six hours after expiry; official example 12:00 creation, 15:00 expiry, 21:00 deadline |
| Withdrawal | Actual vault balance minus unresolved session caps/allocations and other encumbrances |
| Demo authority | Provisional signed-evidence alert off-chain; fork, coverage application, settlement, and revocation authoritative on-chain |

## Open risks accepted for v0.1

| Risk | Severity | Why unresolved |
|---|---|---|
| Hidden forks/shared guarantee | High | Offline merchant cannot know aggregate competing exposure |
| Payer-merchant collusion and multi-wallet self-merchant | High | Address inequality is not real related-party detection |
| Certificate issuer mis-attestation/availability | High | Offline portability still trusts an issuer, though it cannot move funds |
| Proof-bundle privacy and QR size | High | Full reachability reveals prior branch history and grows linearly to depth 32 |
| Valid-claim spam/account growth | High | Coverage cap bounds payout, not number of signed sibling claims |
| Economic viability of collateral ratios | High | Requires merchant/user research and real conflict-rate data |
| Offline clock manipulation/backdating | Medium | `created_at` is advisory; only on-chain submission deadline is authoritative |
| Public metadata correlation | Medium | Wallets, merchants, values, times, hashes, and conflicts are public |
| Software Ed25519 device-key compromise | High | Cross-platform hardware-backed Ed25519 is not a P0 assumption |
| Reconciler/indexer liveness | Medium | Correctness is permissionless/verifiable, but someone must submit/finalize evidence |
| Hash grinding for dust priority | Low | Can influence only residual minor units, not base allocation or cap |

## Kill-criteria audit

The project must be reconsidered if:

1. merchants cannot verify economically useful offline information;
2. program-payable liability can exceed a collateral-related cap or reserved backing can be withdrawn;
3. a central reconciler must become unilateral final authority;
4. usable collateral ratios are economically irrational;
5. the real demo cannot show signed fork evidence, program confirmation, collateral settlement, and enforced revocation.

The specification addresses these as falsifiable criteria; it does not claim empirical success on merchant utility or collateral economics.

## Acceptance checklist

- [x] Official three-value economic model incorporated.
- [x] Branch limit explicitly not an aggregate guarantee under device compromise.
- [x] Fifteen simultaneous claim-eligibility predicates represented, plus reachability/depth and trivial self-merchant controls.
- [x] Normal, simple, triple, replay, invalid-branch, and same-sequence fork cases defined.
- [x] No canonical branch, arrival priority, or authoritative offline timestamp.
- [x] `FULLY_COVERED` and `INSOLVENT` behavior deterministic in minor units.
- [x] Six-hour claim grace window and full-cap withdrawal reserve specified.
- [x] One active/claimable session per payer.
- [x] Official session states and separate user revocation modeled.
- [x] Collect/finalize claim lifecycle specified; no immediate settlement.
- [x] Hybrid reconciliation and critical on-chain verification retained in ADR.
- [x] Ed25519, SHA-256, canonical Borsh, CSPRNG, and full domain separation specified.
- [x] Mock KYC object fields and no-PII boundary specified; KYC not used to decide historical claims.
- [x] Official authoritative events and provisional demo detection mapped.
- [x] Trust assumptions, privacy leakage, open risks, and kill criteria documented.
- [x] Requirement-to-test traceability updated.
- [x] No program, mobile, dashboard, or Sprint 1 implementation created.

## Known implementation unknowns

Sprint 0 does not prove transaction-size feasibility, compute budgets, account sizes, exact Ed25519 instruction layout, Borsh library interoperability, QR capacity, mobile secure-storage behavior, or paginated-finalization throughput. These require later implementation tests and may force a reviewed ADR change; they are not silently assumed solved.

## Review commands

```powershell
rg --files
git diff --check
rg -n "DECIDED FOR MVP|DEFERRED|OPEN RISK" docs
rg -n "collateral_locked|branch_spending_limit|collateral_coverage_cap" docs
rg -n "FULLY_COVERED|INSOLVENT|AuthenticatedForkConfirmed|CollateralCoverageApplied" docs
rg -n "DOUBLE SPEND ATTEMPTED|FORK DETECTED|COLLATERAL COVERS CLAIMS|OFFLINE ACCESS REVOKED" docs/demo-script.md
```

## Gate

Sprint 1 remains blocked until owner review and explicit authorization. The highest-value review questions are commercial acceptance of shared/pro-rata coverage, QR acceptability of full proof bundles, and tolerance for the explicit certificate-issuer trust assumption.

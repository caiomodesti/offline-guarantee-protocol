# ADR-0017: Sprint 6 verified economic resolution

- Status: Accepted for MVP
- Date: 2026-08-13

## Context

Sprint 6 must turn the authority-free Sprint 5 graph into authoritative coverage and SPL settlement without trusting a reconstructor, claim arrival order, offline timestamps, or an operator key. ADR-0005 requires paginated completeness; ADR-0003 freezes the full eligible set and uses credential-hash dust order; ADR-0009 keeps the full cap reserved through the claim window.

A cursor over caller-supplied sorted accounts is insufficient by itself: a malicious first caller could select a non-minimum hash and permanently omit earlier claims. Conflict classification also cannot trust a submitted label because fork descendants must be proven from an authenticated ancestor.

## Decision

### Authoritative fork and revocation

Every unique edge registers a `ForkRecord` PDA keyed by `(session, parent_state_hash, sequence)`. A second distinct child is sufficient because each child already passed domain, Ed25519, transition, merchant, deadline, reachability, and edge-PDA verification. Confirmation atomically makes `authenticated_fork` sticky, records `CONFLICTED`, revokes the user profile, and emits `AuthenticatedForkConfirmed`, `SessionMarkedConflicted`, and `OfflineAccessRevoked`. Triple forks increment the same child count. Duplicate wrappers do not increment it.

Revocation blocks new sessions but does not reject timely historical claims for the conflicted session.

### Deterministic claim index

Claim submission maintains a program-verified doubly linked list ordered by unsigned `credential_hash`. The caller supplies predecessor and successor witnesses. The program verifies adjacency, boundary sentinels, session ownership, and strict ordering before changing links. A bad hint fails atomically and cannot corrupt the list.

All valid wrappers enter this list, including `DUPLICATE_STATE_EDGE` wrappers. When a smaller wrapper becomes an edge's representative, the former representative is atomically changed to rejected and the new representative becomes the sole submitted economic claim. Exposure counters do not change.

### Three-phase finalization

After `Clock.unix_timestamp > claim_submission_deadline`, any caller may:

1. `begin_finalization`: close claim ingestion and freeze edge count and aggregate exposure;
2. `classify_edge`: process edges topologically. A direct edge is conflicting when its final fork record has at least two children. A descendant is conflicting when its verified parent is conflicting. Every edge is processed once; completion requires frozen count and amount equality;
3. `allocate_next_claim`: traverse exactly from the stored list head. Rejected wrappers receive zero. Representatives receive the stored base allocation plus one dust unit for the first `remainder` representatives. Completion requires wrapper traversal, edge count, and allocation-sum equality.

The base is calculated with checked `u128` arithmetic:

```text
coverage = min(frozen_exposure, collateral_coverage_cap)
base_i = floor(amount_i * coverage / frozen_exposure)
remainder = coverage - sum(base_i)
```

The resolution hash is domain-separated by protocol version, program ID, session PDA, frozen counters, cap, and the ordered representative allocation records. Duplicate wrappers are completeness evidence but do not alter economic allocation or the representative-only resolution chain.

On allocation completion, the vault reserve changes from the full cap to unpaid allocations. The unused `cap - coverage` is released only then. `CoverageCalculated` and `CollateralCoverageApplied` are emitted from this authoritative transition.

### Settlement, close, and withdrawal

`settle_claim` accepts only the deterministic representative, stored allocation, configured classic SPL mint, canonical vault token PDA, and an SPL destination owned by the merchant signed in the credential. `transfer_checked` is signed only by the vault PDA. Claim, edge, session, and vault accounting update atomically; replay and destination substitution fail.

Conflicted or insolvent sessions close atomically with their last nonzero settlement. Normal fully settled sessions are closed permissionlessly. Zero allocations are treated as settled without a token CPI.

Withdrawal is owner-signed and allowed only when:

```text
amount <= deposited_amount - reserved_amount
amount <= actual_vault_token_balance - reserved_amount
```

Both subtractions and the transfer/accounting update are checked in one transaction. Direct donations never increase `deposited_amount`.

## Trust assumptions

- No reconciliation or settlement authority exists.
- Callers provide ordering and ancestry witnesses, but the program verifies every security-critical predicate.
- Solana Clock is authoritative for the claim deadline. Signed offline timestamps remain metadata/eligibility bounds, never order proof.
- Classic SPL Token and the configured mint behave according to their deployed programs; Token-2022 and malicious-mint policy remain deferred.

## Consequences

- Settlement remains deterministic under arrival permutations and relayer retries.
- Finalization is resumable and permissionless; session account writes serialize concurrent work.
- Linked claim accounts add 65 bytes each and ordering witnesses add submission account locks.
- Classification is topological and may require multiple transactions.
- A six-hour validator test requires a persisted-ledger restart with `--warp-slot`; the production program contains no time bypass.
- Claim/account spam, linked-list insertion availability, compute scaling, rent, dust hash grinding, and permanent direct-donation recovery remain open production risks.


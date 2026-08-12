# ADR-0010: v0.1 session, claim, and authoritative-event lifecycle

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

User revocation, claim collection, coverage, insolvency, and explanatory demo detection are different concerns. Combining them in one generic state or settling claims on arrival would create ambiguity and manipulable priority.

## Decision

Session states are `ACTIVE`, `CLAIM_WINDOW`, `RECONCILING`, `SETTLED`, `CONFLICTED`, `INSOLVENT`, and `CLOSED`. Revocation remains in `UserRiskProfile`; `authenticated_fork` is a sticky session fact. Claims enter `SUBMITTED`, are frozen/classified only after the deadline, and are then settled from stored deterministic allocations.

`SETTLED` means normal transfers have completed, not merely that coverage was calculated. Conflicted and insolvent sessions retain those states during payout and become `CLOSED` only after all allocations and residual locks are resolved.

Coverage is also stored orthogonally as `UNCALCULATED`, `FULLY_COVERED`, or `INSOLVENT`, so closing a session does not erase its economic outcome.

Off-chain comparison may produce only a provisional `ProvisionalForkDetection`. Authoritative events are `OfflineSessionCreated`, `ClaimSubmitted`, `AuthenticatedForkConfirmed`, `SessionMarkedConflicted`, `CoverageCalculated`, `CollateralCoverageApplied`, `ClaimSettled`, `OfflineAccessRevoked`, and `SessionClosed`.

## Consequences

- `DOUBLE SPEND ATTEMPTED` must be visibly provisional and cannot move value.
- `FORK DETECTED` requires confirmed `AuthenticatedForkConfirmed` evidence.
- No claim is paid first-come-first-served.
- A conflicted session remains claimable until its deadline despite payer revocation.
- Solana time does not mutate accounts automatically; phase transitions are materialized permissionlessly or at instruction entry.

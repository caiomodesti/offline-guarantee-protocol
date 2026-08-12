# ADR-0003: Arrival-independent coverage policy

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

Forks can make aggregate eligible exposure exceed a branch limit or collateral. “First claim wins” rewards network position and contradicts offline fairness.

## Decision

Freeze timely eligible claims after the deadline. If total exposure is within the cap, set `FULLY_COVERED` and pay every claim in full. Otherwise set `INSOLVENT`, allocate `floor(amount_i * cap / total)`, and distribute remaining minor units by ascending credential hash. Every valid branch participates; timestamps and arrival order never prioritize a claim.

## Consequences

- Both conflicting merchants can receive payment.
- Total allocation equals but never exceeds the cap.
- Merchants may receive partial payment and must be warned offline.
- Hash grinding can influence at most dust units; accepted as an open MVP risk.
- Settlement cannot finalize early.

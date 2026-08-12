# ADR-0008: PDA custody and preliminary account concurrency model

- Status: Accepted for MVP design
- Date: 2026-08-10

## Context

Collateral custody, duplicate protection, and simultaneous merchant submissions require deterministic ownership and locking. Exact account sizes must follow implementation measurement.

## Decision

Use a program-owned config, user profile, vault state, session, claim per credential hash, economic state-edge record, and compact fork record. SPL collateral is held by a vault PDA-controlled token account. Only one non-terminal session per payer is allowed for MVP. Claim PDAs provide exact-wrapper idempotency; state-edge records provide economic idempotency when signed wrappers differ but the state transition is identical. Session writes serialize counter updates, favoring safety over throughput.

Every instruction validates owner, signer, seeds, bump, program ID, mint, token program, session, status, and authority. Admin, emergency, upgrade, certificate, wallet, and PDA authorities are distinct.

## Consequences

- Concurrency on a hot session account may limit claim throughput.
- Rent/account count can grow with claims.
- Exact layouts, realloc avoidance, close recipients, and compute budgets must be decided before Sprint 3 implementation.
- Batched/compressed claims are deferred; scalability is an open risk.

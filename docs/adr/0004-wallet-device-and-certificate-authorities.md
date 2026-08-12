# ADR-0004: Separate wallet, device, and certificate authorities

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

Using the wallet key for every payment expands compromise impact. A self-asserted offline certificate cannot prove locked collateral.

## Decision

The wallet signs a session-scoped device authorization. A fresh portable Ed25519 device key signs payments. `create_offline_session` creates `ACTIVE` on-chain state and reserves collateral. A configured certificate issuer may sign a portable representation only after reading that finalized state; it has no session-activation instruction or economic authority. Claims inconsistent with the authoritative session are rejected.

## Consequences

- Device compromise is scoped by session, branch limit, cap, and expiry.
- Certificate portability has an explicit issuer trust assumption.
- Issuer unavailability can delay delivery of a usable portable certificate but cannot modify the session or move value.
- Program reconciliation rejects certificates inconsistent with on-chain state.
- Replacing the issuer with chain-state or threshold proofs is deferred.

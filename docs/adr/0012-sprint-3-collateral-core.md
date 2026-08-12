# ADR-0012: Sprint 3 collateral core

Status: DECIDED FOR MVP  
Date: 2026-08-11

## Context

Sprint 3 must make collateral custody and session activation authoritative on Solana without prematurely implementing claims or reconciliation. The design also contained an inconsistency: the normative MVP architecture said the coverage cap equals locked collateral, while the portable credential validator allowed a smaller cap.

## Decision

1. The MVP uses the classic SPL Token program and a single configured settlement mint. Token-2022 assets are not accepted even though its Anchor interface support is compiled for macro compatibility.
2. Each owner/mint pair has one `CollateralVault` PDA and one token-account PDA. The vault PDA is the token account authority; no user or administrator key directly controls custody.
3. `deposited_amount` is protocol accounting, `reserved_amount` is collateral unavailable to other sessions, and the actual SPL balance is an independent lower-bound check. Direct token donations do not silently increase protocol-accounted deposits.
4. `collateral_coverage_cap` is derived on-chain and MUST equal `collateral_locked` for MVP v0.1. It is not an instruction argument.
5. Session economics require:

   ```text
   collateral_locked * 10_000 >= branch_spending_limit * 30_000
   new_reserved <= deposited_amount
   new_reserved <= actual_vault_token_balance
   ```

   Products are evaluated as `u128`; all additions and timestamp arithmetic are checked.
6. `issued_at` comes from the Solana clock. `expires_at` must be strictly after issuance and at most three hours later. `claim_submission_deadline` is derived as `expires_at + 6 hours`.
7. The config stores distinct admin, emergency, identity, and certificate-issuer authorities. Admin or emergency authority may pause; only admin may unpause. Pause blocks profile creation, vault creation, deposits, and session creation.
8. Identity data on-chain is limited to an opaque hash, issuer, expiry, access status, and risk counters. Raw identity/PII remains off-chain.
9. One active session per profile is enforced. Session release, claims, withdrawal, settlement, and revocation are intentionally outside Sprint 3.

## Consequences

- A successfully created session has its full maximum protocol liability reserved before it becomes `ACTIVE`.
- Forked aggregate exposure can exceed the branch limit or locked collateral, but protocol liability cannot exceed the derived coverage cap.
- The MVP cannot support fee-on-transfer, Token-2022, rebasing, or multiple settlement mints.
- Because no release instruction exists yet, Sprint 3 is conservative: reserved collateral cannot be freed.
- The portable credential fixtures and validation now enforce equality between coverage cap and locked collateral.

## Trust assumptions

- The configured SPL mint behaves as a classic SPL token and its issuer/freeze controls are suitable for the demo.
- The identity authority only registers valid opaque attestations.
- The certificate issuer signs only certificates matching finalized on-chain sessions.
- Solana runtime, clock sysvar, Anchor account validation, and SPL Token CPI execute correctly.

## Deferred

- Authority rotation/governance, mint migration, withdrawal, claim ingestion, reconciliation, settlement, revocation, and local-validator integration tests.

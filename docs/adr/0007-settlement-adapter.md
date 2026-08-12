# ADR-0007: Mock SPL settlement adapter

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

The protocol should preserve rail independence without claiming real Pix or bank integration.

## Decision

Define a settlement boundary but implement only a PDA-authorized mock SPL token adapter in the relevant future sprint. Collateral and settlement use the same mint for MVP, eliminating price-oracle risk. A database is never settlement evidence.

## Consequences

- Token transfers and account deltas demonstrate real economic state locally/devnet.
- No token price or BRL redemption claim exists.
- Pix, PSP, real stablecoin, cross-mint collateral, and oracle valuation are deferred.

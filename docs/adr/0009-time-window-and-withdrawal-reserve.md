# ADR-0009: Separate time windows and full-cap withdrawal reserve

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

Merchants need reconnection time after credentials stop being legitimately created. Releasing collateral at session expiry would expose late-arriving claims.

## Decision

`expires_at` ends legitimate credential creation; `claim_submission_deadline = expires_at + 6h` ends first claim submission. The official example is 12:00 creation, 15:00 expiry, and 21:00 deadline. Signed offline timestamps do not prove order. The full unpaid coverage cap remains reserved until a post-deadline resolution/no-claims finalization, then only unpaid allocations remain reserved.

## Consequences

- Withdrawal cannot front-run disconnected merchants.
- Capital stays locked longer than the three-hour payment session.
- The hackathon demo must use prepared/clock-advanced sessions, never bypass deadlines.
- Backdating remains an open risk.

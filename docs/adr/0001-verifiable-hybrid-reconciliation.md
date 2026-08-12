# ADR-0001: Verifiable hybrid reconciliation

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

Full graph reconstruction is expensive on-chain. Trusting a reconciler to declare conflicts or allocations would undermine neutral verification.

## Options

1. Fully on-chain: strongest independent execution, highest compute/data/complexity, poor hackathon fit.
2. Off-chain reconstruction with on-chain verification: medium cost, untrusted relayers, high but tractable complexity, good evolution path.
3. Explicit reconciliation authority: lowest cost and complexity, but centralized correctness/censorship and key risk.

The detailed comparison is normative in `docs/architecture.md`.

## Decision

Choose option 2. Claims, signature-verification instructions, state transitions, parent-key fork records, frozen-set completeness, arithmetic, and allocations are verified by the program. Registration of a second distinct valid child detects conflict without a reconciliation authority. Reconstruction and visualization remain off-chain. Work is permissionless and resumable.

## Consequences

- No authority can invent a claim or unilateral resolution.
- Program verification and batching are security-critical.
- Transaction sizing and claim volume remain open risks.
- Production may evolve toward compression, state proofs, or ZK proofs without changing the economic policy.

# ADR-0005: Compact claims and verified paginated finalization

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

Storing complete credentials and traversing an arbitrary graph on-chain is costly. Storing only a reconstructor's root would not prove completeness.

## Decision

Full canonical evidence stays off-chain. Each merchant receives a complete genesis-to-tip proof bundle of at most 32 credentials. Collection creates a compact `SUBMITTED` claim PDA keyed by `(session, credential_hash)` and records only economic fields/status. It also registers the economic state edge keyed by `(session, parent_hash, sequence, child_hash)`. Exact credential replay returns `DUPLICATE_CREDENTIAL`; a different valid wrapper for an already registered edge returns `DUPLICATE_STATE_EDGE` and never increments economic counters. The edge record tracks the lexicographically smallest timely valid credential hash as deterministic representative. Bundle credentials are verified and registered topologically so reachability can be checked. A parent-key fork record is created/updated; program confirmation of its second distinct individually valid child emits the authoritative fork/conflict events and revokes access. Relay is permissionless, but each destination is the merchant signed by the device. Session counters track unique economic-edge count and aggregate amount.

After the deadline, any caller starts finalization. Claims are processed in ascending credential-hash pages. For each page the program:

1. verifies account ownership/session/status and strict increasing order;
2. marks each claim included exactly once;
3. updates processed count, processed amount, rolling resolution hash, and cursor;
4. computes the deterministic allocation from frozen total and cap.

Finalization completes only when processed count and amount equal the session's authoritative frozen counters. Anyone may resume an interrupted batch. Settlement consumes stored allocations. No claim is paid during collection. Off-chain fork detection before program confirmation is explicitly provisional.

## Consequences

- Reconstructor omission, duplication, and order manipulation are rejected.
- Arrival order does not determine allocations.
- Claimants/relayers must supply complete parent evidence and pay account costs.
- Proof bundles leak prior branch history and grow linearly to the depth cap.
- Concurrent claim submission is closed at deadline before counters freeze.
- Account growth, maximum practical pages, and spam remain open risks requiring benchmark tests.

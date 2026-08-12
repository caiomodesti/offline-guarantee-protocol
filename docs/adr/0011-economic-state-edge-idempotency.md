# ADR-0011: Economic state-edge idempotency

- Status: Accepted for MVP
- Date: 2026-08-11

## Context

Sprint 2 demonstrated that `credential_hash` is not, by itself, an economic-payment identifier. `PaymentCredential` signs metadata such as `created_at` and `merchant_device_key`, while `PaymentState` intentionally hashes only the fields that determine the branch state. A payer can therefore create two individually valid credential wrappers with different credential hashes but the same parent, sequence, child hash, merchant, amount, challenge, and remaining values. This requires no SHA-256 collision.

Counting both wrappers would create two allocations for one state transition and violate idempotency. Treating them as a fork would also be wrong because the child-set cardinality remains one.

## Decision

The MVP uses two distinct identities:

```text
credential identity = credential_hash
economic edge identity = (session_id, previous_state_hash, sequence, new_state_hash)
```

- Repeating the exact credential identity is `DUPLICATE_CREDENTIAL`.
- A different valid credential identity for an existing economic edge is `DUPLICATE_STATE_EDGE`.
- Both cases contribute exactly one graph edge, one exposure amount, and at most one allocation.
- If multiple timely valid wrappers represent an edge, the unsigned lexicographically smallest `credential_hash` is its deterministic representative.
- Fork detection continues to count distinct valid child hashes for `(session, parent, sequence)` and is unaffected by wrapper count.
- Sprint 4 must combine the claim PDA keyed by credential hash with a `StateEdgeRecord` keyed by the economic edge. Only unique edge records increment session economic counters.

Merchant and amount are part of `PaymentState`, so valid wrappers for the same edge cannot redirect settlement or change face value. A genuine collision between different `PaymentState` payloads remains an accepted cryptographic open risk.

## Consequences

- Economic results are independent of wrapper replay and submission order.
- Coverage and dust ordering operate on unique state edges using their representative hashes.
- Claim collection needs an additional compact account/index and more compute/rent.
- Metadata/hash grinding remains possible but cannot multiply face-value exposure; dust grinding remains bounded to minor units under Coverage Policy V1.
- On-chain account sizing and concurrency for `StateEdgeRecord` must be measured before Sprint 4 implementation.


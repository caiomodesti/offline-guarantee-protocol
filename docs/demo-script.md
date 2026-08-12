# Demo contract — OGP v0.1

This document is a functional requirement. Dashboard state is never protocol evidence. Provisional off-chain detection and authoritative on-chain confirmation are visually and semantically distinct.

## Deterministic fixture

The future `pnpm demo:reset` target creates:

- mock two-decimal SPL mint;
- mock signed KYC attestation and active payer profile;
- `50000` session collateral lock (R$500 simulated);
- `15000` branch spending limit (R$150);
- `50000` collateral coverage cap;
- three-hour session and six-hour claim grace window;
- one payer wallet, one scoped Ed25519 device key, and two distinct merchant wallets.

The UI states that the asset is simulated and displays “Simulating compromised payer device” during the adversarial act.

## Normal act

1. Payer deposits collateral and creates an on-chain `ACTIVE` session.
2. Certificate issuer signs the finalized session representation; it gains no custody or reconciliation power.
3. Merchant generates a 32-byte CSPRNG challenge offline.
4. Payer signs the canonical Borsh credential and proof bundle.
5. Merchant verifies certificate, device authorization, domain, full state path, challenge, merchant, amount, branch limit, and signature.
6. Merchant displays:

```text
PAYMENT CREDENTIAL ACCEPTED
GUARANTEE VERIFIED
PENDING RECONCILIATION
```

7. On reconnection the claim becomes `SUBMITTED`; it is not paid during the claim window.
8. After the deadline, permissionless finalization classifies and settles it.

## Adversarial act

The isolated demo controller rolls back a valid local state and creates two individually valid credentials:

```text
             H1A — Merchant A — R$100
            /
          H0
            \
             H1B — Merchant B — R$100
```

Both have the same session, parent `H0`, and sequence `1`, but distinct signed payment fields and `new_state_hash` values. Each branch spends R$100, below the R$150 branch limit. Unique aggregate exposure is R$200.

## Headline evidence contract

| Message | Evidence | State change | Event/output | Frontend rule |
|---|---|---|---|---|
| `DOUBLE SPEND ATTEMPTED` | Off-chain reconciler runs the production canonical decoder/signature/transition verifier and obtains two individually authenticated credentials with same session/parent/sequence and different children | None | Structured `ProvisionalForkDetection` result containing credential hashes and predicate results; not an on-chain event | Must display `PROVISIONAL DETECTION`; never triggered by `demoMode`, animation state, or unverified payloads |
| `FORK DETECTED` | Solana program independently verifies economically critical fields/signatures and confirms the authenticated sibling predicate | `authenticated_fork=true`, session `CONFLICTED`, profile access disabled, conflict count incremented | `AuthenticatedForkConfirmed`, `SessionMarkedConflicted`, and `OfflineAccessRevoked` in the same transaction | Only after confirmed transaction and matching session/profile/fork accounts |
| `COLLATERAL COVERS CLAIMS` | Frozen eligible total is `20000`, cap is `50000`, allocations are full, and settlement/accounting has actually applied `20000` | Claims become `SETTLED`; collateral used `20000`; residual session lock `30000` becomes releasable when liabilities reach zero | `CoverageCalculated { status: FULLY_COVERED }`, then `CollateralCoverageApplied { eligible_claim_total: 20000, collateral_used: 20000, collateral_remaining: 30000 }`, plus `ClaimSettled` | Headline appears only after confirmed `CollateralCoverageApplied` and verified token/account deltas, never on a proposed plan |
| `OFFLINE ACCESS REVOKED` | Same authoritative fork confirmation | `UserRiskProfile.offline_access_enabled=false`, `revoked_at` set | `OfflineAccessRevoked { reason: AUTHENTICATED_FORK }` | Fetch profile, then submit a real new-session transaction and show its on-chain failure |

The revocation event occurs atomically with fork confirmation, before economic settlement. The narrative may explain coverage before revealing the revocation panel, but it must preserve transaction order and never imply a human made the decision.

## Finalization

After `claim_submission_deadline`:

```text
SUBMITTED claims
      ↓
permissionless reconciliation
      ↓
authenticated DAG + fork confirmation
      ↓
eligible total = 20000
coverage cap = 50000
coverage status = FULLY_COVERED
      ↓
settle 20000
      ↓
CLOSED + payer offline access remains revoked
```

The insolvency path is specified and tested later but is not the main demo. It would show `coverage_status = INSOLVENT` and deterministic pro-rata allocations.

## Demo acceptance assertions

1. Mutating amount, merchant, challenge, domain, parent, sequence, or signature prevents provisional authentication and on-chain fork confirmation.
2. Exact replay produces `DUPLICATE_CREDENTIAL`, never a fork.
3. One valid plus one invalid credential produces no authenticated economic fork.
4. Triple fork produces one parent record with three distinct children.
5. No claim settles before the deadline/finalization.
6. Deleting dashboard/indexer state and replaying chain data restores every authoritative headline.
7. The provisional headline is always visibly labeled and can be recomputed from stored canonical evidence.
8. The post-fork session-creation attempt fails in the program.
9. Demo controller has no privileged validation or settlement bypass.

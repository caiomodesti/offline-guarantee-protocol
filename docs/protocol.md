# Protocol specification

Status: **Normative for MVP design**

## Primitive types

| Type | Representation |
|---|---|
| Monetary amount | `u64`, mint minor units, checked arithmetic only |
| Timestamp | `i64` Unix seconds, on-chain time where authoritative |
| Sequence | `u32` |
| Hash/challenge/session nonce | exactly 32 bytes |
| Solana/Ed25519 public key | exactly 32 bytes |
| Ed25519 signature | exactly 64 bytes |
| Protocol version | `u16`, MVP value `1` |
| Environment | `u8` enum plus 32-byte cluster genesis hash |

No float, negative monetary value, implicit string normalization, or unbounded collection is permitted in signed payloads.

## Core objects

### UserRiskProfile

```text
owner: Pubkey
identity_attestation_hash: [u8; 32]
identity_issuer: Pubkey
risk_tier: u8                 // MVP = 1
offline_access_enabled: bool
successful_sessions: u32
conflict_count: u32
revoked_at: i64               // 0 means not revoked
```

No PII is permitted. A revoked profile MUST NOT create a session.

### IdentityAttestation

Portable mock-KYC object:

```text
domain
issuer: Pubkey
subject_wallet: Pubkey
assurance_level: u8
issued_at: i64
expires_at: i64
attestation_id: [u8; 32]
status: AttestationStatus
issuer_signature: [u8; 64]
```

On-chain state keeps only issuer, attestation hash/ID, assurance level, expiry, and status. No PII is permitted. Attestation validity gates profile/session authorization; it is not a claim-validity input and merchants need learn only that the configured identity requirement was satisfied.

### CollateralVault

```text
owner: Pubkey
token_mint: Pubkey
token_account: Pubkey         // PDA-controlled SPL account
deposited_amount: u64
reserved_amount: u64
settled_from_collateral: u64
```

Derived values:

```text
available_amount = deposited_amount - reserved_amount
```

All operations use checked arithmetic and cross-check the actual SPL token-account amount. Book accounting alone is insufficient.

### OfflineSession

```text
session_id: [u8; 32]
owner: Pubkey
device_public_key: Pubkey
collateral_vault: Pubkey
collateral_locked: u64
branch_spending_limit: u64
collateral_coverage_cap: u64
max_branch_depth: u32          // MVP = 32
issued_at: i64
expires_at: i64
claim_submission_deadline: i64
status: SessionStatus
authenticated_fork: bool
coverage_status: CoverageStatus
genesis_state_hash: [u8; 32]
device_authorization_hash: [u8; 32]
identity_attestation_hash: [u8; 32]
settled_amount: u64
aggregate_offline_exposure: u64  // final reconciliation metric
unique_edge_count: u64
conflicting_claim_count: u64
resolution_hash: [u8; 32]
frozen_edge_count: u64
frozen_exposure: u64
submitted_claim_count: u64
classified_edge_count: u64
classified_exposure: u64
base_allocation_total: u64
allocated_edge_count: u64
allocated_total: u64
scanned_claim_count: u64
settled_edge_count: u64
claim_head: Pubkey
claim_tail: Pubkey
next_allocation_claim: Pubkey
classification_complete: bool
allocation_complete: bool
```

The host reconstructor still reports `conflicting_amount`: the sum of unique eligible amounts in all subtrees beginning at a child of any verified fork point. On-chain finalization stores the corresponding representative count and per-edge conflict flags; aggregate amount remains independently reproducible from those immutable edge accounts.

MVP constraints:

```text
duration = expires_at - issued_at <= 3 hours
claim_submission_deadline = expires_at + 6 hours
branch_spending_limit <= floor(collateral_locked * 10000 / 30000)
collateral_coverage_cap = collateral_locked          // MVP v0.1
one non-terminal session per payer
max_branch_depth = 32
```

The ratio check SHOULD be implemented without lossy division:

```text
collateral_locked * 10000 >= branch_spending_limit * minimum_ratio_bps
```

using checked `u128` intermediates.

### SessionStatus

`ACTIVE`, `CLAIM_WINDOW`, `RECONCILING`, `SETTLED`, `CONFLICTED`, `INSOLVENT`, `CLOSED`.

`CONFLICTED` records an authenticated fork. `INSOLVENT` records `eligible_total > collateral_coverage_cap`. `CLOSED` is terminal. Revocation is not a session state: it belongs to `UserRiskProfile`. The sticky `authenticated_fork` flag remains true through `RECONCILING`, `INSOLVENT`, and `CLOSED` so lifecycle transitions never erase incident history.

`CoverageStatus` is `UNCALCULATED`, `FULLY_COVERED`, or `INSOLVENT`. It is authoritative and remains stored after `CLOSED`.

### DeviceAuthorization

A wallet-signed object binding exactly one device key to one session:

```text
domain
owner
device_public_key
session_id
vault
branch_spending_limit
collateral_coverage_cap
max_branch_depth
issued_at
expires_at
authorization_nonce
wallet_signature
```

The wallet cannot sign this object before the session transaction because `issued_at` comes from `Solana Clock`. The deterministic lifecycle is:

1. the wallet signs `create_offline_session`, which fixes the device key and derives `issued_at` plus `genesis_state_hash` on-chain;
2. after confirmation, the wallet signs `DeviceAuthorization` over those finalized facts;
3. the owner registers its canonical hash once on-chain;
4. only then may the issuer produce `SessionCertificate` and claims be submitted.

The initial session transaction signature is the on-chain authorization. The portable signature is the offline-verification artifact. See [ADR-0014](adr/0014-post-confirmation-portable-authorization.md).

### SessionCertificate

```text
domain
session_id
owner
device_public_key
vault
token_mint
branch_spending_limit
collateral_locked
collateral_coverage_cap
max_branch_depth
issued_at
expires_at
claim_submission_deadline
genesis_state_hash
device_authorization_hash
identity_attestation_hash
issuer
finalized_slot
certificate_nonce
issuer_signature
```

`create_offline_session` creates authoritative `ACTIVE` state and reserves `collateral_locked`. `register_device_authorization` must then record the owner-authorized portable artifact hash. The certificate issuer MUST read that finalized on-chain session before signing its portable representation. The issuer cannot create the session, move collateral, classify claims, reconcile, revoke, or settle. A claim whose certificate differs from immutable on-chain session parameters is rejected. Offline merchants trust issuer accuracy/freshness until `expires_at`; replacing that explicit trust with chain-state proofs is deferred.

### PaymentCredential

```text
domain
session_id
sequence
payer
payer_device_key
merchant
merchant_device_key
amount
previous_state_hash
new_state_hash
previous_remaining
new_remaining
merchant_challenge
created_at                  // signed metadata, not absolute ordering proof
session_expires_at
payer_signature
```

`merchant_device_key` is interaction context and is not a substitute for the signed merchant settlement authority. A relayer cannot redirect settlement.

### CredentialProofBundle

```text
session_certificate
device_authorization
credentials: PaymentCredential[]  // strict genesis-to-tip order, length <= 32
```

A credential that references only a parent hash does not prove reachability. Therefore the payer MUST transmit the complete branch prefix from genesis through the new credential. The merchant verifies the whole bundle and stores it. On reconnect, any party MAY relay a bundle; every resulting claim is immutably payable only to the merchant signed in its credential. A merchant signature is not required for relay, preventing loss of reachability when an earlier merchant is unavailable.

This decision bounds proof size but reveals prior branch merchants and amounts to later merchants. It is an explicit MVP privacy/scalability tradeoff.

### Claim

```text
credential_hash: [u8; 32]
session_id: [u8; 32]
merchant: Pubkey
amount: u64
sequence: u32
previous_state_hash: [u8; 32]
new_state_hash: [u8; 32]
submitted_slot: u64
status: ClaimStatus
allocated_amount: u64
settled_amount: u64
previous_claim: Pubkey
next_claim: Pubkey
allocation_processed: bool
```

Statuses: `SUBMITTED`, `VALID`, `CONFLICTING`, `SETTLED`, `REJECTED`. Collection creates `SUBMITTED`, never an immediate payout. Finalization changes eligible claims to `VALID` or `CONFLICTING`, invalid claims to `REJECTED`, and paid claims to `SETTLED`. Exact repeated submission maps to the existing claim and returns `DUPLICATE_CREDENTIAL`; it does not create a second account or allocation.

Economic idempotency is additionally keyed by the state edge `(session_id, previous_state_hash, sequence, new_state_hash)`. Two valid credentials can have different `credential_hash` values yet encode the same economic edge when only signed metadata excluded from `PaymentState`, such as `created_at`, differs. Such wrappers are classified `DUPLICATE_STATE_EDGE`, contribute one edge and one amount, and can never receive two allocations. The deterministic representative is the unsigned lexicographically smallest timely valid `credential_hash` for that edge.

For verified pagination, all timely valid wrappers are inserted into a program-validated doubly linked list in unsigned ascending `credential_hash` order. Predecessor/successor hints are untrusted witnesses: invalid adjacency, boundary, or ordering fails atomically. Changing an edge representative atomically rejects the former representative and promotes the smaller wrapper without changing economic counters.

## Genesis and transitions

Genesis has:

```text
sequence = 0
remaining = branch_spending_limit
state_hash = SHA256(canonical GenesisState payload)
```

For a payment at sequence `n > 0`:

```text
n = parent.sequence + 1
0 < amount <= previous_remaining
new_remaining = previous_remaining - amount
new_state_hash = SHA256(canonical PaymentState payload)
```

The state payload includes the complete cryptographic domain, session ID, previous hash, sequence, merchant, amount, challenge, previous remaining, and new remaining. A state is valid only if reachable from the session genesis through valid edges.

## Offline merchant verification

A merchant MUST:

1. decode canonical bytes with exact lengths and no trailing bytes;
2. verify certificate domain and issuer against locally trusted protocol configuration;
3. verify issuer signature and wallet device authorization;
4. verify certificate/session consistency;
5. use a CSPRNG to generate a fresh non-zero 32-byte challenge;
6. verify every credential in the complete genesis-to-tip proof bundle;
7. verify payer device signatures, exact merchant/challenge binding, transition arithmetic, sequence, hashes, positive amounts, branch depth, and remaining values;
8. reject when its local clock reports `now > expires_at`;
9. persist the full certificate and credential before showing acceptance.

Clock checks are risk controls, not cryptographic proof of time. The UI MUST say “pending settlement” and MUST NOT imply that the merchant has exclusive collateral.

## Claim classification

### Eligible claim

A unique credential is eligible if and only if all conditions hold:

1. its certificate signature, wallet authorization, and device signature are valid;
2. all domain fields exactly match the configured cluster, program, protocol version, object type, and session;
3. the on-chain session exists and its immutable parameters match the certificate;
4. `amount > 0`, checked transition arithmetic holds, and the state hash recomputes exactly;
5. its parent is genesis or a valid reachable credential, and sequence increments by one;
6. its path spend does not exceed `branch_spending_limit`;
7. its sequence is at most `max_branch_depth`;
8. its `merchant` equals the immutable claim settlement destination; relay authority cannot replace it;
9. its `merchant` differs from the payer wallet for the MVP's trivial self-merchant check;
10. its challenge is exactly 32 non-zero bytes and matches the signed merchant interaction;
11. signed `created_at` is numerically within `[issued_at, expires_at]`, recognizing that this is only an internal consistency check, not proof of real time;
12. the claim transaction was accepted on-chain no later than `claim_submission_deadline`;
13. it is not an exact replay already represented by the same `credential_hash`;
14. its economic state edge is not already represented by another eligible wrapper, except that the smallest credential hash deterministically represents the edge.

For offline acceptance, condition 1 requires the portable certificate and wallet authorization signatures. During on-chain collection, the issuer signature is not redundantly replayed in every claim: the program reads the authoritative session account, requires its one-shot registered authorization hash, and verifies the economically authoritative device signature through the native Ed25519 program. This removes rather than adds relayer trust; the certificate issuer remains only the offline portability trust root. See [ADR-0015](adr/0015-sprint-4-claim-verification.md).

Eligibility is independent of branch choice: valid credentials on conflicting branches remain eligible.

Off-chain comparison of two authenticated incompatible credentials MAY produce the provisional incident `DOUBLE SPEND ATTEMPTED`, but it changes no economic state. Claim/evidence submission derives a `ForkRecord` from `(session_id, previous_state_hash, sequence)`. The first individually verified child initializes it. Registering a later timely verified claim with a distinct child hash makes the program confirm an authenticated fork, update the record, and perform the conflict/revocation transition atomically. It emits `AuthenticatedForkConfirmed`, `SessionMarkedConflicted`, and `OfflineAccessRevoked`. A third distinct child increases the branch count without repeating profile revocation.

Timely claims may be registered while the session is `ACTIVE`, `CLAIM_WINDOW`, or `CONFLICTED`. At expiry, any instruction first materializes `CLAIM_WINDOW` when no conflict is recorded. At the deadline, permissionless finalization changes a payable session to `RECONCILING` and freezes counters while preserving `authenticated_fork`. `SETTLED`, `INSOLVENT`, `CLOSED`, and already-frozen sessions reject new claim registration.

### Invalid claim

A claim is invalid and receives allocation zero if any eligibility condition fails. Stable reason codes include `INVALID_SESSION_CERTIFICATE`, `INVALID_DEVICE_AUTHORIZATION`, `INVALID_SIGNATURE`, `DOMAIN_MISMATCH`, `SESSION_MISMATCH`, `MERCHANT_MISMATCH`, `SELF_MERCHANT_FORBIDDEN`, `INVALID_CHALLENGE`, `INVALID_AMOUNT`, `INVALID_TRANSITION`, `INVALID_PARENT`, `BRANCH_LIMIT_EXCEEDED`, `BRANCH_DEPTH_EXCEEDED`, `SESSION_EXPIRED_METADATA`, and `CLAIM_DEADLINE_PASSED`.

An exact replay is classified separately as `DUPLICATE_CREDENTIAL`. A distinct wrapper for an existing state edge is `DUPLICATE_STATE_EDGE`. Neither creates a second economic claim. A credential with an invalid signature never contributes to a fork.

## Formal DAG and fork definition

Let `V` contain genesis and every cryptographically valid credential state. Let each credential define a directed edge:

```text
e = (session_id, parent_hash, sequence, child_hash, credential_hash)
```

An edge belongs to the reconciled DAG only when its parent is reachable from genesis and its sequence is exactly the parent sequence plus one.

A fork exists at key `k = (session_id, parent_hash, sequence)` iff the set below has cardinality greater than one:

```text
Children(k) = { child_hash(e) | valid reachable e and key(e) = k }
fork(k) <=> |Children(k)| > 1
```

The minimum four predicates in the request are necessary but not sufficient alone. Both edges must also be canonically decodable, correctly signed, domain/session bound, transition-valid, and reachable from genesis. Otherwise an attacker could revoke a payer using fabricated garbage.

### Examples

**Normal branch**

```text
H0 --(seq 1)--> H1 --(seq 2)--> H2
```

Every fork key has one child; no fork.

**Simple fork**

```text
                 H2A
                /
H0 --> H1 -- seq 2
                \
                 H2B
```

Both valid edges have `(session, H1, 2)` and different children; one fork with two branches.

**Triple fork**

```text
              H2A
             /
H0 --> H1 --+-- H2B
             \
              H2C
```

`|Children(session, H1, 2)| = 3`; one fork point, three branches.

**Identical replay**

Submitting the same canonical credential twice produces the same credential and child hashes. The second submission is `DUPLICATE_CREDENTIAL`; child-set cardinality remains one.

**Different wrapper, identical state edge**

Two valid signed credentials may differ only in authenticated non-state metadata such as `created_at`. Their credential hashes differ, but the complete `PaymentState` fields and `new_state_hash` are identical. The lexicographically smallest credential hash represents one economic edge; the other is `DUPLICATE_STATE_EDGE`. This is not a fork and is not a second payable claim.

**Invalid credential branch**

If H2B has a bad signature, wrong merchant, invalid arithmetic, or cannot reach genesis, it is excluded from `V`. H2A plus invalid H2B is not a protocol fork and cannot trigger revocation.

**Two different payments with the same sequence**

- Same valid parent and different resulting hashes: fork.
- Different parents: they are not siblings at that sequence; the graph already diverged at an earlier reachable fork, which is the canonical fork point.
- Same parent and same resulting hash but different credential bytes: `DUPLICATE_STATE_EDGE` when both wrappers validate to the identical `PaymentState`; one economic edge is retained. If distinct state payloads produce the same SHA-256 hash, that is a cryptographic collision **OPEN RISK** treated as computationally infeasible.

## Coverage policy V1

### Freeze point

Claims MAY be submitted during the claim window but MUST NOT receive final allocation or settlement before `claim_submission_deadline`. The exact boundary is deterministic: submission is allowed while `Solana Clock <= claim_submission_deadline`; finalization is allowed only when `Solana Clock > claim_submission_deadline`. The eligible set is then frozen. This prevents arrival order or early settlement from changing later merchants' allocations. A prepared demo MAY use a session whose deadline has already passed; it MUST NOT bypass this rule.

### Aggregate and cap

Let `E` be all unique eligible economic state edges, including all valid branches. Every edge has exactly one deterministic representative credential. Let:

```text
T = sum(amount_i for i in E)                 // aggregate_offline_exposure
C = collateral_coverage_cap
```

Checked `u128` intermediates are required.

### `FULLY_COVERED` (`T <= C`)

Every eligible claim receives `allocation_i = amount_i`. Therefore merchants on all conflicting branches can be paid in full when aggregate exposure is within the cap. For the no-claims case, `T = 0`, applied collateral is zero and no ratio is displayed.

### `INSOLVENT` (`T > C`)

Every eligible claim receives a deterministic pro-rata allocation:

```text
base_i = floor(amount_i * C / T)
remainder_units = C - sum(base_i)
```

Sort economic claims by unsigned lexicographic order of their representative `credential_hash`. The first `remainder_units` claims receive one additional minor unit. Thus:

```text
allocation_i = base_i + dust_i
sum(allocation_i) = C
0 <= allocation_i <= amount_i
```

Official insolvency example in minor units:

```text
claims = [30000, 20000, 15000]
T = 65000
C = 50000
base = [23076, 15384, 11538]
remainder_units = 2
```

After sorting the three claims by credential hash, the first two receive one extra unit. The allocation multiset is therefore `[23077, 15385, 11538]` and sums exactly to `50000`; which merchant receives which of the first two values is determined only by its credential-hash rank.

Arrival order, submission slot, `created_at`, merchant identity, branch label, and reconstructor ordering MUST NOT influence allocation. This policy makes no moral claim about which branch occurred first.

Coverage ratios are represented as integer numerator/denominator or basis points using checked integer arithmetic, never float. For `C = 50000` and `T = 20000`, the UI may render `250%`; for insolvency the payout ratio is `C/T` and drives the pro-rata formula above.

After coverage calculation:

```text
T > C                                  => session.status = INSOLVENT while pro-rata allocations settle
T <= C and authenticated_fork = true   => session.status = CONFLICTED while full allocations settle
T <= C and authenticated_fork = false  => session.status remains RECONCILING until full settlement
```

For a normal fully covered session, completion of every transfer first records `SETTLED`; `close_session` then releases residual lock and records `CLOSED`. Conflicted or insolvent sessions move directly to `CLOSED` after every allocation settles and residual accounting is released. `authenticated_fork` remains sticky.

### Protocol responsibility

For a session:

```text
maximum_protocol_liability = collateral_coverage_cap
sum(all settlements) <= collateral_coverage_cap = collateral_locked
```

Nominal signed exposure can exceed the cap; the protocol does not guarantee full payment above it. Merchants MUST see the cap and this shared-coverage caveat offline.

### Conflict and revocation

The session enters `CONFLICTED` exactly when the program confirms that an on-chain fork record contains at least two individually valid, reachable sibling child hashes. Invalid credentials, duplicates, claims first presented after the deadline, or two edges merely sharing a sequence do not suffice.

In the same atomic state transition, the program MUST:

1. increment `conflict_count`;
2. set `offline_access_enabled = false`;
3. set `revoked_at` if not already set;
4. emit `AuthenticatedForkConfirmed`, `SessionMarkedConflicted`, and `OfflineAccessRevoked` in that order.

Revocation does not invalidate merchants' existing eligible claims and does not unlock collateral.

## Withdrawal safety

For each non-terminal session `s`, define `reserve_s`:

```text
before resolution is finalized:
  reserve_s = collateral_coverage_cap_s - settled_amount_s

after a resolution is finalized:
  reserve_s = sum(unpaid allocation_i for session s)

after all allocations are settled, the session is `CLOSED`, or a no-claims resolution is finalized:
  reserve_s = 0
```

The full cap remains reserved through the claim window, even if no claims have arrived. Merely reaching the deadline does not unlock it; a permissionless finalization must freeze the set and produce either a resolution or a no-claims result.

For vault token balance `B`:

```text
required_reserve = sum(reserve_s) + other_protocol_encumbrances
withdrawable = max(0, B - required_reserve)
withdraw(amount) allowed iff amount <= withdrawable
```

The instruction MUST recompute/check authoritative account state and actual SPL balance atomically. It MUST fail for stale proposed values, open cap reservations, pending allocations, arithmetic failure, wrong mint/owner/program, or paused unsafe paths. This rule ensures a withdrawal never reduces collateral below exposure that may still appear during an open claim window.

## Resolution result

```text
ReconciliationResult {
  session_id
  eligible_credentials
  invalid_credentials_with_reasons
  duplicate_credentials
  state_graph_commitment
  fork_witnesses
  aggregate_offline_exposure
  conflicting_amount
  collateral_coverage_cap
  coverage_status                 // FULLY_COVERED | INSOLVENT
  ordered_allocations
  resolution_hash
}
```

The program recomputes security-critical predicates and the resolution hash. The full explanatory graph may remain off-chain, but fork witnesses and allocations must be independently checkable. It emits `CoverageCalculated` after finalization and `CollateralCoverageApplied` only when authoritative token/accounting changes have applied `collateral_used = min(T, C)`. `collateral_remaining = collateral_locked - collateral_used`; unused collateral is released only when outstanding allocations are zero.

## Known unresolved economic attacks

Merchant collusion across multiple wallets, compromised KYC accounts, intentional hash grinding for one-unit dust priority, denial-of-service claim spam, and availability loss are not solved. The MVP requires `payer_wallet != merchant_wallet`, which blocks only the trivial self-merchant case. Hash grinding affects at most dust allocation under the MVP formula; it does not increase the cap. OGP v0.1 protects merchants against bounded conflicting payer histories; it does not provide complete fraud resistance against payer-merchant collusion. These are `OPEN RISK`, not hidden assumptions.

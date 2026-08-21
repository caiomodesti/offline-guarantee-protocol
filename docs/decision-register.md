# Sprint 0 decision register

Every architectural question is classified. “Open risk” means the MVP behavior is still deterministic, but a residual assumption can undermine viability.

| Question | Classification | MVP answer or boundary |
|---|---|---|
| What is OGP? | DECIDED FOR MVP | Collateral, scoped authorization, signed evidence, reconciliation, coverage, and revocation protocol |
| Is double spending prevented offline? | DECIDED FOR MVP | No; valid forks are detected when evidence is submitted |
| Economic source of truth | DECIDED FOR MVP | Solana program and PDA-controlled SPL vault |
| Settlement asset | DECIDED FOR MVP | Mock SPL token with two decimals; no real BRL/Pix claim |
| Money arithmetic | DECIDED FOR MVP | `u64` minor units with checked `u128` intermediates |
| Sessions per payer | DECIDED FOR MVP | One non-terminal session |
| Session states | DECIDED FOR MVP | `ACTIVE`, `CLAIM_WINDOW`, `RECONCILING`, `SETTLED`, `CONFLICTED`, `INSOLVENT`, `CLOSED`; user revocation is separate |
| Proof of state reachability | DECIDED FOR MVP | Complete genesis-to-tip credential proof bundle, maximum branch depth 32 |
| Branch limit | DECIDED FOR MVP | `15000` demo maximum; enforced on every reachable path |
| Aggregate exposure | DECIDED FOR MVP | Sum of unique eligible DAG edges; common prefix/replays counted once |
| Coverage cap | DECIDED FOR MVP | Session-locked maximum settlement, `50000` in demo |
| Minimum ratio | DECIDED FOR MVP | 300%, checked without lossy division |
| Session duration | DECIDED FOR MVP | At most 3 hours |
| Claim deadline | DECIDED FOR MVP | `expires_at + 6h`; official 12:00/15:00/21:00 example |
| Claim lifecycle | DECIDED FOR MVP | Collect as `SUBMITTED`, freeze/reconcile after deadline, then settle; never immediate payout |
| Can settlement occur before deadline? | DECIDED FOR MVP | No; eligible set must freeze first |
| Eligible claims on conflicting branches | DECIDED FOR MVP | All individually valid, unique, reachable, timely, merchant-bound credentials |
| Can both conflicting merchants receive? | DECIDED FOR MVP | Yes; full under `FULLY_COVERED`, pro-rata under `INSOLVENT` |
| Coverage statuses | DECIDED FOR MVP | Persisted `CoverageStatus`: `UNCALCULATED`, `FULLY_COVERED` when eligible total <= cap, `INSOLVENT` otherwise |
| Insolvent collateral ordering | DECIDED FOR MVP | Pro-rata floor, dust by ascending credential hash |
| Can arrival/time order influence allocation? | DECIDED FOR MVP | No |
| Conflict definition | DECIDED FOR MVP | More than one distinct valid reachable child for same session/parent/sequence |
| When payer is revoked | DECIDED FOR MVP | Atomically when timely registration adds a second valid distinct child to a parent-key fork record |
| Do existing claims survive revocation? | DECIDED FOR MVP | Yes |
| Reconciliation architecture | DECIDED FOR MVP | Off-chain reconstruction plus on-chain verified claims, evidence, completeness, and allocation |
| Reconciliation authority | DECIDED FOR MVP | None with unilateral correctness power |
| Portable certificate authority | DECIDED FOR MVP | Explicit configured issuer attests finalized session; cannot move funds |
| Certificate activation | DECIDED FOR MVP | No issuer activation authority; session is `ACTIVE` on creation and claims must match its immutable on-chain fields |
| Issuer availability | OPEN RISK | Issuer can delay portable certificate delivery but cannot alter session state or move funds |
| Certificate issuer replacement | DEFERRED | Chain-state/light-client proof or multi-issuer design |
| Cryptographic primitives | DECIDED FOR MVP | Ed25519, SHA-256, 32-byte CSPRNG challenges |
| Domain separation | DECIDED FOR MVP | Version, schema, object tag, environment, genesis hash, program ID, session ID |
| Canonical encoding | DECIDED FOR MVP | Canonical Borsh with frozen v1 schemas and strict decode |
| Offline timestamps | DECIDED FOR MVP | Signed metadata and local risk check, never absolute ordering proof |
| Withdrawal safety | DECIDED FOR MVP | Full unpaid cap reserved until finalized resolution; formula in protocol spec |
| Claim storage | DECIDED FOR MVP | Full bytes off-chain; compact per-claim state and resolution inclusion on-chain |
| Vault versus session lock | DECIDED FOR MVP | Session reserves only `collateral_locked`; unreserved vault balance remains withdrawable |
| Scalable compressed claim storage | DEFERRED | Batching/compression/proofs after measured MVP |
| Identity | DECIDED FOR MVP | Opaque mock attestation; no PII on-chain |
| Identity expires after session issuance | DECIDED FOR MVP | Existing timely credentials remain eligible; future sessions are blocked |
| Real KYC/Pix/PSP | DEFERRED | Explicitly outside MVP |
| QR transport | DECIDED FOR MVP | `OGPQR1` fragmented, SHA-256-bound canonical payloads; out-of-order/duplicate-safe, mixed/tampered/incomplete transfer rejection |
| Merchant challenge session binding | DECIDED FOR MVP | Initial unsigned challenge is environment-bound because merchant does not yet know payer session; the signed response binds all economic fields to the exact session domain |
| QR receipt authority | DECIDED FOR MVP | Transport acknowledgement only; no settlement, coverage, time-order, or economic authority |
| Mobile restart safety | DECIDED FOR MVP | Payer persists the new proof bundle before display and resumes pending delivery; merchant persists challenge and evidence before acceptance |
| Payer data loss or reinstall | DECIDED FOR MVP | Offline access fails closed; recovery requires connectivity, authoritative chain read, and wallet signature; a prior active session blocks fresh exposure |
| Compromised full-device snapshot rollback | OPEN RISK | Software cannot prove monotonic storage on a rooted device; fork detection, collateral, deterministic reconciliation, and Sprint 9 adversarial proof bound the result |
| MWA against local validator | OPEN RISK | MWA 2.0 officially identifies mainnet/testnet/devnet, not localnet; Sprint 8 uses an injected signer boundary for validator E2E and must not pull Sprint 12 devnet forward |
| Physical MWA recovery proof in H0 | DEFERRED | H0 accepts the two-device fail-closed storage lifecycle plus validator-backed controller proof; physical public-cluster MWA evidence remains Sprint 12 and cannot be replaced by a fake local wallet |
| Crash-consistent mobile economic state | DECIDED FOR MVP | Generation-scoped components, public prepared/committed manifests and a protected current/pending journal; incomplete, mixed, public-only or rolled-back snapshots fail closed per ADR-0020 |
| Bluetooth/NFC | DEFERRED | After functional QR flow / future |
| Merchant receipt signature | DEFERRED | Potential time/non-repudiation enhancement |
| Privacy | OPEN RISK | Public metadata permits correlation; no MVP privacy guarantee |
| Prior branch privacy | OPEN RISK | Later merchants see earlier credentials in the MVP proof bundle |
| Offline clock/backdating | OPEN RISK | Cannot be proven without additional assumptions |
| Hidden fork at acceptance | OPEN RISK | Merchant cannot know competing branches while offline |
| Issuer compromise | OPEN RISK | Can mislead offline merchant, although program rejects inconsistent claims |
| Trivial self-merchant | DECIDED FOR MVP | Reject when `payer_wallet == merchant_wallet` |
| Merchant collusion/multi-wallet self-merchant | OPEN RISK | Address inequality is only a minimal mitigation; abuse economics unresolved |
| Claim spam and resolution scale | OPEN RISK | May harm liveness/economics; must be benchmarked |
| Device software-key compromise | OPEN RISK | H2 source audit confirms the Ed25519 seed is returned to JavaScript; SecureStore protects it at rest but does not make the OGP signer non-exportable. Session/time/cap and deterministic settlement bound liability |
| Hardware-backed device identity | DEFERRED | ADR-0021 retains portable Ed25519 for MVP. Both devices support non-exportable TEE AES/P-256, only Device A supports StrongBox, and neither AndroidKeyStore provider supports Ed25519. Any non-exportable signer or attestation protocol requires a new ADR and approval |
| Evidence availability | OPEN RISK | Merchant must retain bytes; durable decentralized storage deferred |
| Upgrade/admin centralization | OPEN RISK | Dev-only key acceptable for hackathon; production requires multisig/timelock plan |
| Emergency pause | DECIDED FOR MVP | Separate authority; cannot erase claims/unlock reserves/block safe settlement |
| `DOUBLE SPEND ATTEMPTED` authority | DECIDED FOR MVP | Provisional off-chain result from production cryptographic verification; no economic state change |
| `FORK DETECTED` authority | DECIDED FOR MVP | Only after `AuthenticatedForkConfirmed` on-chain and matching state changes |
| Reinstatement after conflict | DEFERRED | No automatic reinstatement in MVP |
| Production formal verification/audit | DEFERRED | Mandatory before valuable deployment, not Sprint 0 implementation |
| Economic viability of collateral ratios | OPEN RISK | 300% MVP ratio is deterministic but commercial acceptability is unproven |

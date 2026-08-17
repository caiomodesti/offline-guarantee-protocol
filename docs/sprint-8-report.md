# Sprint 8 — Normal on-chain E2E report

Status: **IN PROGRESS**  
Source of truth: original Prompt Master, Sprint 8 only  
Started: 2026-08-15

## Fixed scope

```text
deposit
→ create session
→ airplane/network-disabled offline payment
→ merchant accepts and persists evidence
→ merchant reconnects
→ claim submitted
→ deterministic finalization and settlement
```

Sprint 8 does not implement the controlled rollback/fork demo (Sprint 9), dashboard (Sprint 10), Bluetooth (Sprint 11), or devnet deployment (Sprint 12).

## Entry evidence

Sprint 7's core offline communication gate passed on two physical Android phones with Wi-Fi and mobile data disabled. The owner observed the complete merchant → payer → merchant → payer camera exchange: branch `1000`, collateral display `3000`, payment `50`, locally verified merchant evidence, matching transport receipt, and payer branch `950`.

The later source-only history improvements have host-test evidence but no new APK was requested or produced.

## Decision 8.1 — fail-closed recovery

[ADR-0019](adr/0019-sprint-8-fail-closed-session-recovery.md) is accepted. Clearing app data, reinstalling, or losing the protected session key disables offline access. Recovery requires online authoritative chain state and a wallet signature. No fresh session/exposure is allowed while `profile.active_session` points to a prior session. Existing merchant claims and collateral reserves survive payer data loss.

## Current implementation increment

The first increment is a deterministic, side-effect-free access decision gate with explicit outcomes for:

- complete local session;
- missing protected key or branch state;
- partial/mismatched backup;
- unavailable chain state;
- prior active session;
- wallet authorization requirement;
- permission to provision a genuinely new session.

The protocol SDK now strictly decodes the fixed `UserProfile` and `OfflineSession` layouts. The recovery adapter verifies expected account addresses, program ownership, confirmed profile state, `profile.active_session`, the separate internal `session_id`, owner, device key, status, and revocation before feeding the decision gate. A hostile implementation check caught and corrected the initial temptation to treat the session PDA and internal `session_id` as the same identifier.

The Sprint 7 fixture remains isolated and labeled. It is not accepted as an input to the Sprint 8 on-chain path.

## Increment 8.2 — portable proof to runtime settlement

The protocol SDK now exposes a single strict bridge from a merchant-verified `PaymentCredential` to the exact 410-byte payload, 64-byte payer-device signature, and 32-byte credential hash required by `submit_claim`. Application code no longer needs to reconstruct economic fields or canonical bytes.

The validator suite now contains a dedicated non-conflicted Sprint 8 path:

1. an injected test-wallet signer deposits 300 and creates a 100-unit session;
2. the confirmed session facts produce a real wallet-signed `DeviceAuthorization` whose hash is registered on-chain;
3. the configured issuer signs a portable `SessionCertificate` bound to the confirmed session;
4. `QRTransport` round-trips the merchant challenge, complete proof bundle, and receipt;
5. the production merchant verifier accepts the exact bundle;
6. the SDK passes that same credential to `submit_claim` with native Ed25519 verification;
7. after the authoritative claim deadline, the runtime freezes and allocates the single 50-unit edge;
8. `settle_claim` transfers 50 SPL units to the merchant through PDA-signed `transfer_checked` and moves the normal session to `Settled` without the payer key;
9. permissionless `close_session` then moves it to `Closed`, clears `profile.active_session`, and increments `successful_sessions` without the payer key.

Increment 8.2 is **PASS** in [GitHub Actions run 31901840994](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31901840994). The run rebuilt the program for SBF from a clean pinned environment, executed the existing runtime suite, persisted and warped the ledger beyond the real claim deadline, and completed the normal claim, allocation, SPL settlement, and explicit session close.

The first runtime attempt exposed a real confirmation race: `.rpc()` had returned, but the newly created session was not yet observable at `confirmed` commitment when portable authorization material was about to be produced. Provisioning now waits for `confirmTransaction(..., "confirmed")` and then fetches the session at `confirmed`. This is a security boundary, not merely a test delay: offline authority must never be derived from a transaction known only at `processed` commitment.

## Increment 8.3 — durable merchant reconnect queue

Merchant evidence now has an explicit local lifecycle instead of the ambiguous legacy label `pending-settlement`:

```text
pending-submission
→ submitted
→ settled | rejected
```

Legacy Sprint 7 entries migrate conservatively to `pending-submission`; no old local record is promoted to an on-chain state. On reconnect, the queue:

1. looks up the credential-hash claim account before submitting;
2. revalidates the complete stored QR proof and derives the exact 410-byte payload through the protocol SDK, never from editable display metadata;
3. submits and waits for transaction confirmation through an injected relayer/RPC boundary;
4. refetches the claim and requires confirmed matching hash, session, amount, and slot before advancing local state;
5. performs another hash lookup after an ambiguous network failure, preventing blind duplicate retries;
6. continues other claims after an individual failure and preserves failed evidence for retry.

The mobile history remains honest: it labels synchronized states as a **local record of the last confirmed observation**, with observed slot/signature, rather than presenting AsyncStorage as current chain truth. The actual Solana RPC/relayer adapter is still pending; this increment deliberately does not simulate connectivity.

Increment 8.3 is **PASS** in [GitHub Actions run 31903471226](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31903471226), including mobile typechecks, 71 host tests, SBF build, and all 37 cumulative validator/runtime checks.

## Increment 8.4 — explicit fail-closed payer runtime

The payer no longer enters the Sprint 7 fixture merely because the application started with empty storage. Runtime selection is now explicit and deterministic:

```text
unset | on-chain
→ ONLINE_RECOVERY_REQUIRED
→ no fixture load
→ no device-session key creation
→ no offline balance creation

development-fixture
→ labeled Sprint 7 demonstration path only
```

An unknown or misspelled runtime mode fails instead of falling back. The existing Sprint 7 APK workflow opts into `development-fixture` at build time so historical demo artifacts remain reproducible; the default source path is `on-chain`. Tests inject a forbidden fixture loader and prove it is never invoked by the default path.

This increment closes the automatic-fixture boot hazard but does not pretend online recovery is already implemented. The production screen says in Portuguese that connectivity, confirmed chain recovery, and wallet authorization are required. The next Sprint 8 increment must place the real recovery/provisioning controller behind this boundary.

## Increment 8.5 — signed recovery controller and confirmed account port

The default payer path now understands a production-format session instead of only displaying a blocked screen. Offline readiness requires all three durable components:

```text
signed provisioning record
+ authenticated branch record
+ protected per-session device key
→ complete cryptographic revalidation
→ OFFLINE_READY
```

The controller validates the configured network, cluster genesis, program ID and certificate issuer; exact canonical authorization/certificate sizes; wallet and issuer signatures; authorization hash; 300%/time/deadline invariants; protected key binding; session/branch identity; and the complete QR credential chain. Editable local `remaining`, sequence, state hash, frames, confirmation slot, account identifiers or partial storage cannot create capacity.

When connected, an injected confirmed-account port reads the profile first and any active session at the same or newer RPC context. It rejects owner, PDA address, program owner and stale-context substitution before calling the access decision engine. With no local material, the chain is not queried until an explicit wallet owner is supplied. A surviving active session blocks reprovisioning; a free confirmed profile produces `NEW_SESSION_ALLOWED`, not a session or balance.

The validator normal path now serializes the real signed material created from its confirmed session, passes it through the mobile persistence/controller code, refetches the real `UserProfile` and `OfflineSession`, and proves `OFFLINE_READY` only after all bindings match. Wallet keys remain outside the controller; the runtime harness supplies an injected test signer while physical MWA remains a later Sprint 8 gate on a supported cluster.

## Automated evidence

```text
TypeScript / Vitest               89 PASS across 16 files
Sprint 8 recovery/queue/adapter  50 PASS
Mobile TypeScript                 payer PASS; merchant PASS
Golden vectors                     6 PASS
Independent Rust conformance       1 PASS
Solana program Rust tests         16 PASS
Real SBF build                     PASS (587,232 bytes)
Validator/runtime assertions       38 PASS
Sprint 8 claim submit compute      39,222 CU
Sprint 8 SPL settlement compute    36,890 CU
Sprint 8 session close compute      9,304 CU
```

Pinned runtime environment: Rust/Cargo 1.97.1, Agave/Solana CLI 3.1.10, Anchor CLI 1.0.2, Node 22.17.0, pnpm 11.16.0. The SBF artifact SHA-256 is `d567c541c21e2e2d543e81d75bc8f27693d1573e50a3df85344ed1bc5b5acde3` for program `7BDWpBB9tvPfk1FBFP6kCen9UECWxa1t5VReu2Q3ybKf` in that ephemeral CI environment.

No APK was generated for this increment, as requested. The physically installed Sprint 7 apps therefore do not yet contain the new recovery gate.

## Hostile audit — increment 8.1

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Easy implementation error | Old session must block new exposure | Initial model used one field for PDA and internal ID | Separate and verify `activeSessionAccount`, session account address, and internal `sessionId`; regression tests | CLOSED |
| High | Easy if fixture leaks into production mode | Fresh capacity must be authorized on-chain | Sprint 7 app still contains compiled fixture | Gate rejects `development-fixture`; real app path must not call `loadDevelopmentSession` | OPEN INTEGRATION GATE |
| High | Ordinary clear-data/reinstall | Local loss must not cancel old obligations or reset balance | No local record plus authoritative active session | `ACTIVE_SESSION_BLOCKS_REPROVISIONING`, even with wallet signature | CLOSED IN DECISION ENGINE; VALIDATOR/MOBILE E2E PENDING |
| High | Rooted/fully compromised device | Monotonic offline branch | Attacker may restore both app data and protected key snapshot | Economic cap, fork evidence, reconciliation and Sprint 9 attack demo | OPEN RISK |
| Medium | Malicious/misconfigured RPC response | Recovery must use program-owned authoritative accounts | Raw account bytes alone are insufficient | Verify expected profile address, active session address, program owner, strict discriminator/size, and confirmation flag | PARTIALLY CLOSED; LIVE RPC WIRING PENDING |
| Medium | Local clock manipulation | Expired sessions must not appear valid indefinitely | Offline clocks are not absolute proof | Certificate/session expiry remains enforced by protocol/merchant validation; add explicit payer UX gate during integration without using it for branch ordering | OPEN INTEGRATION GATE |
| Medium | Standard MWA wallet versus local validator | Wallet-authorized Sprint 8 provisioning | MWA 2.0 officially defines mainnet/testnet/devnet chain identifiers, not localnet | Keep chronology: validator E2E uses an injected signer boundary; compile/test the MWA adapter; reserve public devnet proof for Sprint 12 | OPEN RISK |
| Low | Account layout drift | Recovery decoder correctness | Manual fixed offsets can drift after Rust changes | Frozen sizes/discriminators and decoder tests; runtime fixtures remain final proof | MITIGATED |

## Hostile audit — increment 8.2

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Intermittent RPC/commitment race | No offline authority may be provisioned from an unconfirmed session | Run 31901217195 returned from `.rpc()` before the account was observable at `confirmed` | Explicitly confirm the session transaction and fetch authoritative facts at `confirmed` before signing authorization/certificate material | CLOSED; run 31901840994 PASS |
| High | Easy application serialization mistake | Merchant-verified bytes must be the bytes admitted on-chain | The mobile/runtime boundary previously required callers to assemble claim arguments themselves | `createClaimSubmissionMaterial` derives the exact 410-byte payload, copied 64-byte signature, and credential hash from the verified credential and rejects layout drift | CLOSED IN SDK + RUNTIME |
| High | Payer disappears permanently after paying offline | Merchant settlement must not depend on payer reconnection or signature | Phase two runs after persisted-ledger restart and contains neither payer owner signer nor payer device key | Any funded relayer can call claim/finalization; vault PDA signs `transfer_checked`; `close_session` is permissionless after complete settlement | CLOSED IN RUNTIME; MOBILE RELAYER WIRING PENDING |
| High | Incorrect client interpretation of status | Collateral/profile release must follow the on-chain lifecycle | Run 31901217195 showed allocation ends in `Reconciling`, not `Settled` | Runtime test now proves `Reconciling -> Settled -> Closed` and verifies reserve, balances, active session, and success counter at each required boundary | CLOSED |
| Medium | Signer or merchant substitution | Only the credential's merchant may receive its allocation | Existing runtime suite rejects wrong destination, signature mutation, instruction-index substitution, and exact replay | Native Ed25519 instruction introspection plus credential/claim/merchant account constraints | CLOSED IN RUNTIME |
| Medium | Rooted device restores an old protected snapshot | A single device branch should be monotonic | Runtime normal path cannot prove Android anti-rollback guarantees | Economic caps and authenticated fork handling bound/resolve exposure; physical rollback attack remains scheduled for Sprint 9 | OPEN RISK |
| Medium | Standard MWA cannot name localnet | Physical wallet-authorized local-validator provisioning | Official MWA chain identifiers omit localnet | Keep injected signer as the local runtime proof; use real MWA only on supported public cluster in Sprint 12 | OPEN RISK; CHRONOLOGY UNCHANGED |
| Medium | CI fixture leakage | Test owner key must never become an application custody pattern | The pre-existing two-phase runtime harness serializes an ephemeral owner key under `target/` so it can continue after validator restart | `target/` is gitignored; the fixture is not uploaded in the runtime artifact or logged; production mobile code remains MWA-only and stores no wallet key | TEST-ONLY; VERIFY ARTIFACT ALLOWLIST CONTINUOUSLY |
| Low | GitHub Actions moves off Node 20 action runtime | Evidence pipeline availability | Run emitted the upstream actions Node 20 deprecation warning while succeeding under forced Node 24 | Upgrade official action majors when stable; no protocol or artifact effect today | OPEN MAINTENANCE |

## Hostile audit — increment 8.3

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Common retry race | One credential must not multiply economic exposure | Submit may succeed while the RPC response is lost | Confirmed hash lookup before submission and after ambiguous failure; on-chain claim PDA and edge idempotency remain final controls | CLOSED IN QUEUE + RUNTIME |
| High | Local metadata tampering | Submitted bytes must equal merchant-verified evidence | Amount/session/hash fields live beside QR frames in AsyncStorage | Revalidate the complete proof and derive payload/signature/hash from its final credential; require all display metadata to match | CLOSED |
| High | False success from transaction signature alone | Dashboard must not claim settlement from local state | A signature can exist before confirmation or without the expected account | Advance only after confirmed, field-matching claim lookup; UI says “última sincronização” and records observed slot/signature | CLOSED IN MODEL; LIVE RPC UI REFRESH PENDING |
| Medium | One broken claim starves the queue | Every timely merchant proof should get a submission attempt | Sequential worker could stop at first exception | Isolate failures and continue deterministic credential-hash traversal | CLOSED |
| Medium | Slow relayer near deadline | Merchant may miss `claim_submission_deadline` despite durable evidence | Queue policy cannot guarantee liveness of an absent backend | Preserve evidence/errors, support interchangeable relayers, expose deadline urgency, and test reconnect before/at/after deadline | OPEN INTEGRATION RISK |
| Medium | Development merchant identity reused | Claim destination must be the real merchant wallet | Sprint 7 app still compiles a public demonstration merchant address | Production mode must source merchant authority/destination from its wallet/account configuration; never introduce a wallet secret into app storage | OPEN INTEGRATION GATE |

## Hostile audit — increment 8.4

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Ordinary clear-data/reinstall | Local loss must never mint fresh offline capacity | The previous app always called `loadDevelopmentSession()` on boot | Default mode returns `ONLINE_RECOVERY_REQUIRED` before any fixture or protected key load | CLOSED IN APP BOOT |
| High | Build misconfiguration | A typo must not enable development collateral/capacity | An implicit fallback could silently choose a demo path | Only exact `development-fixture` opts in; all unknown values throw | CLOSED |
| High | Production artifact contains demonstration material | Fixture secrets must never become a production custody mechanism | Source still imports the Sprint 7 fixture module for the explicit historical demo build | Create distinct production/demo entrypoints and verify production bundle absence before mobile signoff | OPEN BUILD-SEPARATION GATE |
| Medium | Recovery UI overpromises functionality | A blocked screen is not on-chain recovery | Default mode currently has no live RPC/MWA controller behind it | UI states the requirement without offering a fake success path; controller remains a Sprint 8 gate | OPEN INTEGRATION GATE |

## Hostile audit — increment 8.5

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| Critical | Ordinary local edit | Local storage must not mint capacity | `remaining`, sequence and state hash are editable JSON | Recompute genesis/full credential chain and require exact equality with stored final state | CLOSED |
| High | Partial backup or interrupted write | Incomplete recovery must not become spendable | AsyncStorage and SecureStore are not one atomic database | Three-component completeness gate; protected key written last; every partial state returns recovery-required | CLOSED IN CONTROLLER |
| High | RPC/account substitution | Only configured program state may authorize recovery | Malicious RPC may return another profile/session or stale session | Verify requested address, program owner, profile owner and same-or-newer confirmed context before strict account decoding | CLOSED IN PORT; MULTI-RPC/LIGHT-CLIENT TRUST REMAINS |
| High | Wallet substitution | Another wallet must not adopt the local session | Wallet address and local certificate owner can diverge | Reject mismatch before any chain request; wallet private key never enters controller/storage | CLOSED |
| High | Forged deployment/issuer configuration | Self-signed certificate could look locally valid | Trusting issuer embedded in certificate would be circular | Require external public network/genesis/program/issuer roots; missing or malformed roots fail closed | CLOSED IN CONFIG; DEPLOYMENT DISTRIBUTION OPEN |
| Medium | Rooted device restores a complete old snapshot | Branch monotonicity cannot be proven in ordinary storage | Attacker may restore valid key plus valid historical chain | Economic cap, merchant claims, fork reconciliation and revocation; controlled proof remains Sprint 9 | OPEN RISK; CHRONOLOGY UNCHANGED |

No program instruction, economic policy, fork behavior, Bluetooth, dashboard, or devnet behavior was added or reordered by this increment. The tests exercise already authorized claim/finalization/settlement functionality to prove the original Sprint 8 normal path.

## Remaining acceptance gates

- connect the implemented recovery/provisioning controller to a real MWA transaction builder and certificate-issuer service on a supported cluster;
- connect the compiled MWA boundary on a supported cluster without storing wallet keys in the app;
- implement the Solana RPC/relayer adapter behind the now-tested durable merchant queue and persist each returned queue state;
- surface authoritative claim, settlement, and session-close states in Portuguese in both apps;
- physically test clear-data/reinstall against authoritative active-session state so it cannot create new exposure;
- run the complete two-phone normal path again after those app integrations.

The protocol/runtime half of the normal Sprint 8 path is accepted. Sprint 8 remains **IN PROGRESS** until the installed applications use this production path instead of the Sprint 7 fixture. No Sprint 9 functionality is authorized yet.

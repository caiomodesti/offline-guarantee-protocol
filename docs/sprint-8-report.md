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

## Increment 8.6 — deterministic portable-authorization orchestration

The payer now has a fail-closed provisioning state machine matching ADR-0014:

```text
explicit wallet authorization
→ confirmed profile is free
→ create_offline_session
→ confirm + refetch immutable session
→ wallet signs canonical DeviceAuthorization payload
→ register_device_authorization(hash)
→ confirm + refetch registered hash
→ certificate issuer independently attests the session
→ client validates issuer signature and every confirmed field
→ branch/public records are written
→ protected device key is committed last
```

No wallet private key enters the controller. Session/device nonces come from an injected secure-entropy boundary. Every 32/64-byte value, requested economic limit, authoritative clock field, deadline, context-slot monotonicity, authorization hash, issuer trust root and recomputed genesis hash is checked before persistence. An existing confirmed active session stops the flow before creation. A valid issuer signature over inconsistent chain facts is still rejected.

This increment implements and tests the orchestration contract, not the physical Android transport. The concrete MWA transaction builder and deployed issuer HTTP boundary remain open Sprint 8 integration gates and must not be described as completed.

## Increment 8.7 — production/demo bundle separation

The payer now has two physically distinct application entrypoints:

```text
package.json -> index.ts -> App.tsx
                        -> on-chain mode fixed in source
                        -> no dependency path to dev-session.ts

package.development.json -> index.development.ts
                         -> App.development.tsx
                         -> explicit development-fixture loader
```

The production entrypoint no longer reads an Expo environment variable capable of selecting the Sprint 7 fixture. Its `App` always constructs `PayerApplication` with `configuredMode="on-chain"`. The runtime boundary also stopped importing `dev-session.ts`; a demonstration caller must provide its fixture loader explicitly or bootstrap fails.

The historical Sprint 7 Android workflow switches to the isolated demonstration manifest before Expo prebuild. The production manifest remains the repository default. A dependency-graph regression test recursively follows relative ESM imports, maps compiled `.js` specifiers back to TypeScript sources, and proves:

1. the production graph cannot reach `dev-session.ts`, `App.development.tsx`, or `index.development.ts`;
2. the demonstration graph reaches the fixture intentionally;
3. production and demonstration manifests are identical except for `main`, preventing dependency/configuration drift.

No APK was generated. This increment closes source/build separation only; it does not claim the on-chain mobile integration is complete.

## Increment 8.8 — concrete merchant RPC/relayer port

The merchant now has a concrete Solana adapter behind the durable claim queue. Its trust boundary is deliberately split:

```text
stored QR frames
→ full portable-proof revalidation
→ exact 410-byte payload + 64-byte payer signature + credential hash
→ session/claim PDA derivation from signed owner/session/hash
→ untrusted HTTP relayer submits the evidence
→ merchant polls Solana at confirmed commitment
→ strict program-owned Claim decode
→ exact session PDA / hash / merchant / amount match
→ only then may local history advance
```

The relayer request identifies protocol version, network, genesis hash, program, session PDA, claim PDA and signed merchant, but it cannot choose a different economic destination or manufacture success. Extra response fields are discarded; only a syntactically valid transaction signature is retained temporarily, and that signature alone never advances claim status. The adapter independently verifies the RPC genesis hash, account owner, frozen discriminator/size and every economically relevant signed field.

Queue processing remains deterministic by credential hash and now accepts a persistence boundary after every processed proof. If durable persistence fails, processing stops before another proof is attempted, preventing a successful observation from existing only in volatile memory. All endpoints require HTTPS, except explicit loopback HTTP for local development; wallet and relayer private keys are absent from the app.

This is source-level production integration, not a claim that a relayer service is deployed. The current installed Sprint 7 APK is unchanged, and no APK was generated. App-screen wiring, endpoint distribution, deadline UX and a two-phone physical reconnect remain Sprint 8 acceptance gates.

## Increment 8.9 — merchant durable UI and deployment isolation

The merchant history screen now invokes the concrete claim port through the deterministic queue and persists every returned queue state in AsyncStorage before processing the next proof. The Portuguese UI exposes an explicit loading state, confirmed/failed totals, observed slot/signature, and honest retry errors. It states that connectivity is used only for submission and confirmed reads; a relayer response or transaction signature alone never means settlement.

Production startup is fail-closed. It requires explicit public configuration for network, genesis hash, program ID, certificate issuer, merchant destination, RPC and relayer. HTTP is accepted only for loopback development; remote endpoints require HTTPS, embedded URL credentials are rejected, and the relayer URL cannot contain query credentials. No private wallet, device, issuer or relayer key is accepted from Expo environment variables.

The historical Sprint 7 merchant fixture was moved behind `index.development.ts` and `package.development.json`, matching the payer separation. The production dependency graph cannot reach `src/trust.ts` or either demonstration entrypoint. The historical APK workflow explicitly selects the demonstration manifest for both apps; the repository default remains production.

Durable state is also domain-scoped by network, genesis, program and merchant. A real deployment therefore cannot silently inherit the demonstration's claims, outstanding challenge or merchant device identity. The explicit historical demo alone retains its old storage namespace so the already-tested offline behavior remains reproducible.

Claim details show `expires_at` separately from `claim_submission_deadline`. Deadline urgency is labeled as a local-clock observation only; it never blocks submission or establishes claim eligibility. The program and Solana Clock remain authoritative.

No production endpoint or relayer service is invented by this increment, and no APK was generated. Live backend deployment and physical reconnection remain open acceptance gates.

## Increment 8.10 — local claim relayer and validator transaction path

Sprint 8 now includes an executable local HTTP relayer rather than only the mobile transport interface. The relayer key remains outside the repository and outside both applications. It is merely the permissionless fee/rent payer for `submit_claim`; signed credential fields and program constraints remain the economic authority.

For every request the service:

1. accepts only the exact version-1 JSON schema and bounded canonical hex/base58 encodings;
2. verifies configured network, genesis and program against the request, signed domain and current RPC genesis;
3. decodes the canonical credential, recomputes its hash and verifies the payer-device Ed25519 signature before spending fees;
4. derives session, claim, profile, edge and fork PDAs rather than trusting supplied addresses;
5. strictly decodes the session and complete program-owned claim list, verifies its count/head/tail/links/order, and computes predecessor/successor deterministically;
6. resolves an existing edge representative or a reachable parent edge from on-chain evidence;
7. builds exactly two instructions: native Ed25519 verification referencing the bytes inside the following Anchor instruction, then `submit_claim`;
8. signs only with the relayer fee-payer key and waits for confirmed execution.

In-process duplicate requests for one credential hash are coalesced. Durable and cross-process idempotency remains the on-chain Claim PDA; an existing PDA returns `409`, and the merchant then performs its already-defined strict authoritative lookup. HTTP requests are capped at 8 KiB, 15 seconds, eight concurrent submissions and 30 submissions per remote address per minute; a separate 45-second submission response timeout avoids hanging clients. Unknown errors are sanitized, and request bodies/private keys are never logged.

The validator harness's normal portable path now calls this exact relayer core instead of constructing the claim transaction inline. It therefore proves the production account planner, native verifier offsets, raw Anchor encoding, signer, PDA creation and program execution together. [GitHub Actions run 31988270674](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31988270674) passed the host suite, real SBF build, validator collection/CPI/invariants and post-deadline economic resolution for commit `ab1c833`. This does not claim a public service deployment: the configured endpoint, TLS/operations, fallback relayer and physical reconnect remain acceptance gates. No APK was generated.

## Automated evidence

```text
TypeScript / Vitest              116 PASS across 23 files
Sprint 8 recovery/queue/adapter  72 PASS
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

Pinned runtime environment: Rust/Cargo 1.97.1, Agave/Solana CLI 3.1.10, Anchor CLI 1.0.2, Node 22.17.0, pnpm 11.16.0. The latest accepted SBF artifact is 587,232 bytes with SHA-256 `4d3617c8fe74bc080fecfafbe0da0dd0c61ffd8d35a3490911977c6888c20b85` for program `5ARWrQTJ4129WpwMSWu3cmSzcomRtdJnXmuoNthbdUFv` in run 31988270674's ephemeral CI environment.

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
| High | Production artifact contains demonstration material | Fixture secrets must never become a production custody mechanism | Source previously imported the Sprint 7 fixture module through the common runtime boundary | Distinct production/demo entrypoints; production dependency-graph exclusion test; historical workflow selects explicit demo manifest | CLOSED IN 8.7 |
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

## Hostile audit — increment 8.6

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Client sequencing error | No certificate before owner authorization is registered | Lifecycle spans two wallet transactions and issuer request | Single ordered orchestrator; confirmed refetch after each transaction; issuer called last | CLOSED IN ORCHESTRATOR; PHYSICAL ADAPTER PENDING |
| High | Malicious/compromised issuer | Portable facts equal authoritative session | A valid issuer signature alone could attest altered genesis or token mint | Compare every immutable certificate field and recompute genesis before persistence | CLOSED FOR CLIENT DETECTION |
| High | Reinstall with active prior session | No duplicate offline exposure | Wallet may reconnect after local deletion | Confirmed recovery decision executes before any entropy or creation call | CLOSED |
| Medium | Crash between lifecycle steps | Partial session must not become offline-ready | Session may reserve collateral before local commit | Protected key written last; partial local state fails closed; lifecycle recovery/closure UX remains required | MITIGATED; RECOVERY UX PENDING |
| Medium | Structural adapter impersonation | Wallet signatures correspond to authorized owner | Host port can be implemented incorrectly | Verify returned portable signature locally; transactions remain constrained by on-chain signer/account checks | CONCRETE MWA ADAPTER TEST PENDING |
| Low | Issuer response from stale slot | Certificate represents registered authorization | Issuer could sign an earlier view | Require certificate `finalizedSlot >=` registered refetch context and exact registered hash | CLOSED IN CLIENT; SERVICE AUDIT PENDING |

## Hostile audit — increment 8.7

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Build-time environment mistake | Production must never embed fixture capacity or secrets | The prior common entrypoint accepted `EXPO_PUBLIC_OGP_RUNTIME_MODE=development-fixture` | Production mode fixed in source; demo uses a separate entrypoint and manifest | CLOSED |
| High | Accidental re-import | A later refactor could make the fixture reachable again | Static source review alone is easy to miss | Recursive production dependency-graph regression test | CLOSED |
| Medium | Production/demo manifest drift | Historical demo could test a different dependency set | Two manifests are necessary for Expo entry selection | Exact structural equality test except for `main` | CLOSED |
| Medium | Test proves source reachability, not a signed APK's byte contents | Production artifact must exclude fixture bytes | No Sprint 8 production APK was requested | Add APK bundle string/content inspection when the production artifact is first built | OPEN ARTIFACT GATE |

## Hostile audit — increment 8.8

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Malicious or wrong-cluster RPC | Only the intended deployment can establish claim truth | An owned byte layout is insufficient if fetched from another cluster/program | Verify configured program equals signed domain, RPC genesis hash, account owner, exact discriminator/size and derived PDA | CLOSED IN ADAPTER; MULTI-RPC TRUST REMAINS |
| High | Dishonest relayer response | Local status must follow on-chain state, not backend assertions | Relayer can return a signature plus fabricated `settled` text | Discard all fields except validated signature; confirm and refetch the exact Claim account before advancing | CLOSED |
| High | Relayer/account substitution | Signed merchant and credential must remain immutable | Backend controls transaction construction and auxiliary claim-order accounts | Send exact revalidated proof; derive expected session/claim PDAs locally; compare on-chain hash, session, merchant and amount | CLOSED; PROGRAM CONSTRAINTS REMAIN FINAL |
| Medium | Crash after one successful queue item | Confirmed observation must survive before processing the next claim | Batch result previously persisted only at caller discretion after the full loop | Await injected durable persistence after each deterministic queue update | CLOSED IN QUEUE; APP STORAGE WIRING PENDING |
| Medium | Relayer censorship or outage near deadline | Timely valid evidence should be submit-able | A single configured service can refuse or disappear | Relayer is replaceable and evidence remains portable; expose deadline and add fallback endpoints before physical acceptance | OPEN INTEGRATION RISK |
| Medium | RPC serves stale confirmed view | UI may lag current settlement status | Confirmed is not finalized and one provider can lag | Record observation slot honestly; idempotent refetch; add refresh/fallback RPC policy | MITIGATED; LIVE POLICY PENDING |

## Hostile audit — increment 8.9

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Build/configuration mistake | Production must not use Sprint 7 merchant identity | The default merchant app previously imported fixed fixture trust and merchant bytes | Separate production/demo entrypoints and manifests; dependency-graph regression test; fail-closed public deployment parser | CLOSED IN SOURCE |
| High | Cross-deployment storage reuse | Evidence and device identity belong to one cryptographic domain | Legacy AsyncStorage/SecureStore keys were global | Scope production keys by network, genesis, program and merchant; retain legacy keys only in explicit demo | CLOSED |
| High | Local signature displayed as success | History must reflect confirmed chain state | UI synchronization could overinterpret a relayer response | Existing queue advances only after strict Claim read; UI labels observations and errors, not backend assertions | CLOSED IN UI MODEL; PHYSICAL TEST PENDING |
| Medium | Mobile interruption during a multi-claim batch | Each observed result must survive independently | App may background or terminate between claims | Await AsyncStorage persistence after every queue update and update visible state incrementally | CLOSED IN CONTROLLER; DEVICE KILL TEST PENDING |
| Medium | Manipulated device clock | Offline timestamp must not decide claim eligibility or branch order | Deadline warnings use `Date.now()` | Advisory wording only; never suppress submission; Solana Clock/program decides | CLOSED |
| Medium | Public endpoint configuration leaked or substituted | App must contact intended deployment without storing secrets | Expo public environment is inspectable by design | Accept public roots/URLs only, reject embedded credentials, verify RPC genesis/program/account after connection | MITIGATED; SIGNED CONFIG DISTRIBUTION OPEN |
| Medium | Refresh failure after a prior confirmed read | Honest local history must not erase confirmed evidence | The original failure helper always reset status to pending | Preserve status/slot/signature and attach the newer RPC error separately; regression test | CLOSED DURING HOSTILE AUDIT |

## Hostile audit — increment 8.10

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| Critical | Trivial if a secret is bundled | Relayer/mobile key separation | A transaction fee payer is required for permissionless submission | Load a 64-byte keypair only from an operator filesystem path; gitignore keypairs; public Expo config accepts no secret | CLOSED IN SOURCE; OPERATOR CUSTODY REMAINS |
| High | Malicious request/RPC substitution | Only the configured cryptographic domain may be submitted | Request contains addresses and RPC is an external trust boundary | Recompute hash/signature/PDAs; compare request, credential domain, configured roots and current RPC genesis on every submission | CLOSED |
| High | Valid-credential replay or concurrent workers | One proof must not multiply exposure | HTTP responses can be lost and multiple relayers can race | In-process single-flight plus program-owned Claim PDA; merchant resolves `409` by authoritative lookup | CLOSED |
| High | Auxiliary-account substitution | Sorted claim insertion and parent reachability must remain valid | `submit_claim` requires predecessor, successor, representative and parent | Strictly decode/verify the entire session claim list and derive all auxiliary accounts; program revalidates atomically | CLOSED; LARGE-LIST SCALING OPEN |
| High | Economic denial of service against relayer | Permissionless fees must not become unlimited operator liability | A payer with valid credentials can create wrappers/claims that consume rent | 8 KiB body cap, request/submission timeouts, concurrency and per-address rate limits, limited funded hot key | MITIGATED FOR LOCAL MVP; PRODUCTION SPONSOR/AUTH POLICY OPEN |
| Medium | RPC state changes between planning and execution | No partial claim/list mutation | Planner reads several accounts before sending | Transaction preflight plus atomic program constraints; failure creates no PDA/list mutation; client retries/refetches | CLOSED BY RUNTIME ATOMICITY; LIVE RACE TEST PENDING |
| Medium | Relayer returns signature while client times out | Local history must not invent failure or success | Submission can finish after HTTP 504 | Existing mobile ambiguous-failure path refetches exact Claim; only program-owned confirmed state advances status | CLOSED IN MODEL; PHYSICAL TEST PENDING |
| Medium | Single endpoint censorship/outage | Merchant must submit before deadline | Local service is not an availability guarantee | Evidence remains portable and relayer has no authority; add independently operated fallback before acceptance | OPEN INTEGRATION RISK |
| Low | Request/log leakage | On-chain-correlatable evidence should not leak unnecessarily before submission | Payload contains merchant/session/value metadata | No body/error-secret logging; bounded sanitized errors; TLS required outside loopback | MITIGATED; ON-CHAIN PRIVACY LEAKAGE UNCHANGED |

## Remaining acceptance gates

- connect the implemented recovery/provisioning state machine to a concrete MWA transaction builder and deployed certificate-issuer service on a supported cluster;
- connect the compiled MWA boundary on a supported cluster without storing wallet keys in the app;
- run/configure the implemented relayer plus a fallback policy and exercise the merchant UI against live authoritative accounts;
- surface authoritative claim, settlement, and session-close states in Portuguese in both apps;
- physically test clear-data/reinstall against authoritative active-session state so it cannot create new exposure;
- run the complete two-phone normal path again after those app integrations.

The protocol/runtime half of the normal Sprint 8 path is accepted. Sprint 8 remains **IN PROGRESS** until the installed applications use this production path instead of the Sprint 7 fixture. No Sprint 9 functionality is authorized yet.

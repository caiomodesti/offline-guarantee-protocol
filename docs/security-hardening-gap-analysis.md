# OGP — Security hardening gap analysis

- Status: analysis only; no production implementation authorized
- Date: 2026-08-17
- Scope: device state, invariant/property testing, QR transport chaos, participant collusion and mobile performance
- Governing source: the original Prompt Master and accepted ADRs remain authoritative
- Current chronology: this is a transversal hardening analysis inside Sprint 8; it does not create, rename, skip or reorder a sprint

## 1. Executive decision

The hardening proposal is compatible with the approved OGP architecture if it is applied as defense in depth. It must not replace deterministic reconciliation, change settlement, modify canonical schemas or weaken `collateral_coverage_cap` without a separate ADR and explicit approval.

The source currently implements a fail-closed production recovery path, but the installed Sprint 7 demonstration APKs do not prove that production behavior. The present device key is a software-generated Ed25519 seed stored as a string through Expo SecureStore. SecureStore protects it at rest, but the seed is returned to JavaScript for signing; therefore the OGP device signing key is not presently a non-exportable Android Keystore signing key and is not proven StrongBox-backed.

The economic last barrier is materially stronger than the device layer: claims, unique economic edges, immutable coverage cap, deterministic allocation and PDA-controlled payouts are enforced on-chain. Existing fixed-scenario tests demonstrate aggregate exposure of 400 against a cap of 300 and capped settlement. What is missing is broad randomized state-machine evidence that the same property holds across adversarial claim graphs, permutations, retries and boundary values.

### GO / NO-GO recommendation

| Item | Decision | Justification |
|---|---|---|
| Preserve current protocol/economics | **GO — DECIDED FOR MVP** | The hardening goals reinforce the accepted architecture and do not require an economic redesign. |
| Reset/clear-data/reinstall test campaign | **GO** | Highest-risk mobile gap; can be added without changing protocol schemas. |
| Claim that production reset/reinstall safety is already proven on real devices | **NO-GO — OPEN RISK** | Host tests cover the decision logic, while the installed APK is the isolated Sprint 7 demonstration. A production binary and physical-device lifecycle matrix have not been executed. |
| Crash-consistent local storage hardening | **GO** | Generation/commit-marker storage and recovery tests can fail closed without altering signed protocol objects. |
| Current SecureStore seed as “hardware-backed/non-exportable OGP identity” | **NO-GO — OPEN RISK** | SecureStore protects a retrievable seed; the app does not generate or attest the actual OGP signing key inside TEE/StrongBox. |
| Evaluate hardware-backed device identity | **GO — DEFERRED implementation** | A spike is justified. Any signer/algorithm or signed-schema change requires an ADR and compatibility plan first. |
| Economic property/state-machine tests | **GO** | High value, low architectural risk and directly tests the protocol's central safety claim. |
| Parser/claim fuzzing | **GO** | Add bounded TypeScript/Rust fuzz targets only after defining invariants and corpus limits. |
| QR transport chaos suite | **GO** | Existing transport is deterministic and bounded but lacks lifecycle interruption/resume coverage. |
| Adversarial collusion suite | **GO** | It can validate the accepted trust model without pretending to prove that a physical sale occurred. |
| Physical-device benchmarks | **GO** | Measurement must precede optimization. |
| Rust/JSI/FFI rewrite now | **NO-GO — DEFERRED** | No measured bottleneck currently justifies native complexity or a new key boundary. |
| Devnet/production security claim based on this analysis alone | **NO-GO** | The document identifies tests and implementation work; it is not execution evidence. |

## 2. Relevant current architecture

### Payer

1. A wallet authorizes session creation through an MWA boundary; wallet private key material is never accepted or stored by the OGP app.
2. A per-session 32-byte Ed25519 secret is generated in software.
3. Public signed provisioning material and the authenticated branch/proof state are stored in AsyncStorage.
4. The device secret is stored separately through Expo SecureStore.
5. Offline bootstrap reads all three components and revalidates domain, issuer signature, device authorization, session certificate, full branch reachability, final state and protected-key/public-key binding.
6. Missing, partial or inconsistent material produces online-recovery-required. A confirmed on-chain active session blocks fresh capacity after local loss.
7. A payment constructs and persists the complete proof chain before advancing the UI. Merchant receipt state is transport metadata, not settlement evidence.

### Merchant

1. The merchant uses a software-generated Ed25519 device secret stored through SecureStore.
2. Outstanding challenge, received proof frames and claim lifecycle metadata are stored in domain-scoped AsyncStorage.
3. The app reconstructs the complete credential bundle, validates cryptography and merchant policy, writes the claim, then removes the outstanding challenge and displays acceptance.
4. Reconnect synchronization revalidates durable evidence, performs authoritative on-chain lookups, submits idempotently through an untrusted relayer and advances local status only from a confirmed, field-matching Claim account.
5. Claim PDA identity and on-chain edge accounting are the durable duplicate/payment barriers; a transaction signature or dashboard state alone is never settlement proof.

### Protocol boundary

- `branch_spending_limit` limits a single authenticated branch.
- `aggregate_offline_exposure` sums unique reachable economic edges across all branches and may exceed the branch limit.
- `collateral_coverage_cap` is immutable for the session and equals collateral locked on-chain.
- Reconciliation is independent of claim arrival order and offline timestamps.
- An authenticated fork is same session, same reachable parent state, same next sequence and different authenticated resulting state hash. Exact replay and two wrappers of the same economic edge do not create extra exposure.
- Payout allocation and vault custody are enforced by the Solana program, not either mobile app or the relayer.

## 3. Where keys and security-relevant state are stored today

| Principal/state | Current location | Security property | Gap/status |
|---|---|---|---|
| Payer wallet private key | External wallet/MWA only | App receives public keys and signatures, not wallet secret | **DECIDED FOR MVP** |
| Payer per-session Ed25519 seed | Expo SecureStore key `ogp.onchain.v1.device-key` | Separate from public state; configured `WHEN_UNLOCKED_THIS_DEVICE_ONLY` | **OPEN RISK:** retrievable into JS; no OGP-key attestation, StrongBox requirement, biometric gate or non-exportability proof |
| Payer signed provisioning | AsyncStorage `ogp.onchain.v1.provisioning` | Public, signed and strictly revalidated | Tamper-evident, not confidential |
| Payer branch/proof chain | AsyncStorage `ogp.onchain.v1.branch-state` | Full chain and final state revalidated before use | Complete-old-snapshot rollback remains possible on a fully compromised device |
| Merchant device Ed25519 seed | Expo SecureStore, domain-scoped production key | Separate from claim evidence | Same exportability/attestation gap as payer key |
| Merchant challenge and claim evidence | Domain-scoped AsyncStorage | Evidence is revalidated before submission; private key is not included | Clear-data loses claim availability; backup can restore public evidence without usable device key |
| Relayer Solana fee-payer keypair | Operator filesystem path from `OGP_RELAYER_KEYPAIR_PATH` | Never accepted in Expo public configuration; keypair patterns ignored by Git | Operator custody remains an operational risk outside device hardening |
| Development/deployment keys | Ephemeral CI/local lifecycle | Keypair files ignored; no tracked keypair found in the current tree | Continue secret scanning in CI/history |

The Expo configuration uses `configureAndroidBackup: true`. According to the [Expo SecureStore documentation](https://docs.expo.dev/versions/v55.0.0/sdk/securestore/), this asks the plugin to configure Android Auto Backup correctly by excluding SecureStore entries, because Android Keystore entries are deleted on uninstall and restored ciphertext would be undecryptable. It does not mean the SecureStore secret itself is backed up.

Android's native Keystore can keep key material non-exportable and restrict its use. StrongBox is optional and supports a smaller algorithm set, notably P-256 rather than a guaranteed Ed25519 path; platform support must be detected rather than assumed. See the [Android Keystore documentation](https://developer.android.com/privacy-and-security/keystore) and [key-attestation guidance](https://developer.android.com/privacy-and-security/security-key-attestation).

## 4. Clear-data, reinstall, copying and rollback

### Current production source behavior

| Event | Expected result from current source | Evidence strength | Status |
|---|---|---|---|
| Clear all app data | All three payer components are absent; offline use is blocked and no capacity is recreated | Host/controller tests | **DECIDED; physical proof pending** |
| Lose only SecureStore secret | Partial record; offline use is blocked | Host/controller tests | **DECIDED** |
| Restore only AsyncStorage backup | Partial record without protected key; offline use is blocked | Host/controller tests plus SecureStore backup exclusion | **DECIDED; Android lifecycle proof pending** |
| Reinstall | No valid local triplet; reconnect and wallet authorization are required. Existing active session blocks new capacity | Host/controller tests | **DECIDED; physical proof pending** |
| Copy AsyncStorage to another device | The copied public record lacks the matching protected secret; offline use is blocked | Structural validation | **DECIDED; adversarial device test pending** |
| Copy merchant evidence without merchant secret | Evidence remains public but fails device-key policy under the new device identity | Structural validation | **DECIDED; test matrix pending** |
| Restore a complete old snapshot including the matching secret | Its signatures and internal state can still be self-consistent; no offline monotonic oracle proves it stale | Threat-model reasoning | **OPEN RISK** |
| Rooted/instrumented device extracts or invokes the software seed | Attacker may deliberately create branches/forks up to what credentials and economics permit | Threat-model reasoning | **OPEN RISK**, bounded by detection/revocation/cap |

### Demonstration APK distinction

The Sprint 7 demo build intentionally contains a labeled fixture. Clearing its data can recreate that demonstration state. This is not acceptable production behavior and is already isolated from the production entrypoint. Therefore the successful two-phone demo proves the QR user flow, not production reset/reinstall resistance.

### Recovery limitation

After legitimate total local loss while an on-chain session remains active, the system blocks new capacity but cannot reconstruct the lost per-session signing secret. That is a safe availability failure: merchants can still submit retained claims, and a later session can start only after the existing lifecycle reaches a terminal/closed state. Silent local “balance recovery” would be unsafe.

## 5. Backup and rollback threat model

Three attacker capabilities must not be conflated:

1. **Ordinary Android backup/restore:** SecureStore ciphertext is excluded and the Keystore entry does not survive uninstall. The restored public half is insufficient and must fail closed.
2. **Application-level copying:** copying AsyncStorage alone is insufficient because the public device key must match the protected signing seed.
3. **Privileged/full-device snapshot:** a rooted, instrumented or otherwise compromised environment may snapshot and restore both public state and a usable software key, or call signing code before/after rollback. Current local validation cannot establish monotonicity offline.

No IMEI, Android ID, serial number or similar identifier should be introduced as a root of trust. Those identifiers are neither secret nor a cryptographic proof of device possession.

Hardware attestation can establish that a platform key resides in TEE/StrongBox only when its certificate chain, security level, challenge and revocation state are verified off-device. Merely requesting a Keystore key or observing an alias is not enough. Even attestation does not by itself provide a universal offline monotonic counter or prove that application state was not rolled back.

## 6. Non-atomic and crash-sensitive storage points

| Flow | Current write order | Safe property already present | Remaining gap |
|---|---|---|---|
| New payer provisioning | branch -> signed provisioning -> SecureStore secret | Protected key is last; any prefix is rejected as partial | Three storage writes are not a transaction; no generation ID, prepared/committed marker, cleanup or fsync evidence |
| Payer payment | compute complete proof chain -> replace branch JSON -> advance UI | A failed awaited write does not intentionally present success | No journal/dual-slot commit; process/OS crash semantics and durable flush are unproven |
| Merchant acceptance | complete assembly -> crypto/policy validation -> append claim JSON -> remove challenge -> accepted UI | Partial transport never reaches the claim write; claim write is awaited before acceptance | Claim and challenge are separate writes; crash can leave both. Deduplication limits duplication, but no transaction/commit generation exists |
| Merchant receipt presentation | update claim receipt metadata in one claims-array rewrite | Does not claim payer acknowledgement or settlement | Whole-array rewrite grows with history; crash/disk-full behavior untested |
| Merchant queue sync | process claim -> persist updated queue -> continue | Stops before advancing if persistence throws; hash order deterministic | Whole-array persistence lacks a durable journal; concurrent app instances are not modeled |
| QR scanning | frames held in component memory until full assembly | Partial scan cannot alter economic state | App death loses progress; resume is not implemented or tested |

Recommended no-protocol-change pattern: versioned records with a random generation ID, `prepared` public records, protected key write, final small `committed` marker, strict generation equality on bootstrap, and deterministic garbage collection only after a complete committed generation validates. Payment/claim state should use a similarly bounded journal or dual-slot record. This improves crash consistency but does not solve privileged rollback of a complete generation.

## 7. Current property-based and fuzzing posture

### Present

`fast-check` is already pinned and used in three properties:

- 64 generated admissible amounts validate checked payment transitions;
- 32 shuffled full-input permutations prove state-graph arrival-order invariance for a fixed fork/duplicate case;
- 32 shuffled permutations prove reconciliation output invariance for a fixed claim set.

Fixed unit and validator tests additionally cover one-byte signature/payload mutations, exact-length rejection, domain separation, branch depth, replay, duplicate state edges, invalid signatures, simple/triple forks, unreachable parents, merchant substitution, deadline gates, real SPL balance/accounting separation, atomic Solana rollback, pro-rata dust, `u64::MAX` multiplication through `u128`, settlement replay and an aggregate-exposure-above-cap scenario.

There is no dedicated fuzz target, generated state-machine model, random DAG generator, arbitrary-byte codec/QR corpus, cross-language differential fuzzing, persisted regression corpus, sanitizer run or fuzz CI budget today.

### Economic invariant matrix

| Invariant | Existing evidence | Gap | Status |
|---|---|---|---|
| `reserved_amount <= deposited_amount` | Runtime session reservation and accounting-vs-donation cases; checked Rust math | Random deposit/reserve/release state sequences | **PARTIAL** |
| `reserved_amount <= actual_vault_balance` | Runtime real SPL checks; unreachable-invalid-state reasoning | Generated instruction sequences and concurrency attempts | **PARTIAL** |
| Total payout `<= collateral_coverage_cap` | Rust allocation tests and fixed validator insolvency case (400 exposure / 300 cap) | Random claims, merchants, forks, order and dust across program/model | **PARTIAL, CRITICAL GAP** |
| Invalid claim never increases liability | Fixed invalid signature, unreachable parent, pause and rollback cases | Arbitrary mutations at every signed/account field and instruction-order adversaries | **PARTIAL** |
| Replay never pays twice | Claim PDA/edge state plus runtime submit/settlement replay cases | Concurrent relayers/retries randomized across transaction boundaries | **PARTIAL** |
| Amount mutation invalidates proof | Crypto and runtime mutation cases | Arbitrary amount boundaries and canonical representations | **PARTIAL** |
| Merchant/recipient substitution fails | Credential policy and runtime account constraints | Multi-merchant randomized recipient/token-account substitution matrix | **PARTIAL** |
| Expired session cannot create new authority | Solana Clock session creation and authorization gates | Generated exact-boundary slots/seconds and reconnect races | **PARTIAL** |
| Arrival order does not change reconciliation/settlement | Host permutation properties; deterministic sorted claim chain | Random graph shapes and on-chain payout differential parity | **PARTIAL** |
| Overflow/underflow fails safely | Checked Rust/TypeScript arithmetic and fixed extrema | Full operation-sequence generation around 0, max and accumulated sums | **PARTIAL** |
| Aggregate exposure may exceed branch limit while liability remains capped | Runtime four-child scenario and immutable cap | Generalized property over arbitrary valid forks and descendants | **PARTIAL, CENTRAL TARGET** |

### Proposed property/fuzz layers

1. **Pure model properties:** generate bounded sessions, valid/invalid DAGs, duplicate wrappers, merchants and amounts. Assert deterministic graph, unique-edge exposure and cap-bound allocation.
2. **State-machine properties:** model deposit, reserve, claim, fork, finalize, settle, close and withdrawal preconditions. Compare each accepted transition with invariants.
3. **Parser fuzzing:** arbitrary bytes/strings into canonical decoders, claim material and QR frames. Required outcome is valid canonical object or bounded typed rejection, never partial economic mutation or uncontrolled allocation.
4. **Differential tests:** compare TypeScript reconciliation/allocation model with Rust program math for the same generated vectors. Add on-chain sampled cases after host shrinking yields minimal failures.
5. **Runtime adversarial cases:** reserve expensive validator runs for minimal shrunk counterexamples and account/CPI/atomicity properties that host models cannot prove.

Start with the already-installed `fast-check` and Rust unit/state-model tests. Do not add a heavy Anchor fuzz framework until the state model and expected CI budget are documented. A formal-verification tool may later be justified for the cap/allocation arithmetic, but it is not a substitute for runtime CPI and account-constraint tests.

## 8. Current QR transport tests and chaos gaps

### Already tested

- challenge and proof round trips;
- multi-frame proof reconstruction out of order;
- identical duplicate frame acceptance;
- missing frame rejection;
- mixed transfers rejection;
- wrong message kind rejection;
- payload tamper/hash failure;
- receipt round trip;
- zero challenge/non-positive amount rejection;
- proof binding to the outstanding merchant request.

The implementation also bounds chunk size, frame count and assembled transfer size; rejects non-canonical indices/counts, conflicting duplicate chunks and final hash mismatch.

### Missing chaos coverage

- corruption at every frame position and field, not only one chunk;
- truncated/overlong Base64URL, hash, numeric and delimiter fields;
- duplicate-index/different-chunk corpus;
- very large but syntactically valid counts/chunks and CPU/memory budget assertions;
- scan interruption at every frame boundary;
- app termination and restart during receive;
- explicit resume protocol and transfer identity selection;
- persisted partial-frame corruption, migration and cleanup;
- two interleaved transfers of the same/different kinds under repeated scans;
- receiving the same complete payload twice through the full merchant UI/storage path;
- disk-full/write-error/crash immediately before and after claim persistence;
- proof validation failure after complete assembly but before persistence;
- evidence persistence success followed by challenge-removal failure.

### Required acceptance rule

A merchant operation is accepted only after complete reconstruction, cryptographic validation, merchant/policy validation and durable evidence persistence. No partial-frame cache, progress indicator, local timestamp or UI screen may increment exposure, create a Claim PDA or represent settlement. If resumable scanning is added, partial frames must live in a separate non-economic namespace and be promoted only by a committed validated-evidence transaction.

## 9. Collusion analysis

The protocol cannot prove that goods or services physically changed hands. Its security objective is narrower and testable: authenticated participants and arbitrary branches cannot cause protocol payout above the immutable coverage cap.

| Scenario | Classification | Current control | Gap/test needed |
|---|---|---|---|
| Payer + merchant sign a fabricated purchase paid from that payer's own collateral | Voluntary collateral movement / participant fraud, not automatically protocol loss | Valid claim consumes bounded payer coverage | Demonstrate exact payer-vault/session binding and capped payout |
| Payer + merchant alter amount after signing | Invalid proof | Signature, state transition and canonical bytes bind amount | Property mutation over every amount encoding/boundary |
| Payer deliberately creates multiple children | Authenticated fork | Unique edges add exposure; session becomes conflicted; payer is revoked; settlement remains capped | Generated double/triple/deep forks and cap parity |
| Two merchants coordinate sibling claims | Participant collusion; may create conflicting eligible claims | Each merchant/challenge/recipient is signed; deterministic capped allocation | Random merchant allocation, dust and recipient substitution |
| Same economic edge wrapped multiple ways | Replay/equivalent-edge attempt | One economic edge; deterministic representative claim | Random wrapper metadata and concurrent submission |
| Merchant reuses exact evidence | Replay attempt | Deterministic Claim PDA and claim/edge settled state | Concurrent relayer and post-settlement retries |
| Merchant changes payout recipient/token account | Protocol fraud attempt | Claim merchant plus SPL owner/mint constraints | Runtime substitution matrix for ATA/non-ATA and wrong mint |
| Claim points to another session/vault/collateral | Protocol fraud attempt | Session ID, PDAs, owner, mint and vault constraints | Cross-session/cross-vault generated account matrices |
| One branch contains valid claim while another contains malformed/invalid evidence | Mixed evidence | Invalid evidence is excluded and cannot create an authenticated fork | Random branch mutation; assert exposure unchanged by invalid child |
| Payer + merchants create exposure greater than branch limit | Expected fork risk | Aggregate exposure records unique branches; payout uses coverage cap | Central generated property: all payouts plus dust never exceed cap |

The critical distinction is:

- **Fraud against the protocol:** protocol-owned funds or liability exceed the payer's immutable covered amount, or value is redirected to an unauthorized recipient. This must be impossible under tested assumptions.
- **Fraud between participants:** a payer and merchant disagree about the real-world transaction while producing or withholding valid evidence. The protocol cannot adjudicate the physical event.
- **Voluntary movement of own collateral:** colluding parties create a valid claim funded solely by the payer's reserved collateral. This can be undesirable or abusive, but it is not insolvency if custody, recipient binding and cap remain intact.

## 10. Performance baseline required before native work

Measure release/standalone builds on the two real Android devices already used for the demo, with airplane mode and normal thermal state recorded. Use deterministic small/medium/max fixtures, warm-up runs and at least median/p95/p99 plus peak memory where available.

| Operation | Required sizes/conditions | Decision signal |
|---|---|---|
| Ed25519 signing | one credential; burst to max branch depth | UI latency, JS stall, secret-boundary cost |
| Ed25519 verification | authorization + certificate + 1/8/32 credentials | Merchant acceptance latency |
| SHA-256 hashing | canonical objects and assembled max proof | Whether hashing is material |
| Canonical encode/decode | every signed type, max proof bundle | Parser throughput and allocation |
| QR serialization/assembly | default and max chunks, ordered/reversed | Frame generation/assembly latency and memory |
| Proof parsing/validation | 1/8/32 credentials, valid and early/late invalid | Worst-case rejection cost |
| Local reconciliation | normal, double fork, triple/deep fork, duplicates | Scaling with edges/branches |
| Durable storage | payer branch and merchant history at bounded maximum | Persistence latency/failure behavior |

Propose Rust/JSI/FFI only if a user-visible or safety-relevant budget is missed consistently and profiling attributes it to crypto/codec rather than QR camera, rendering, storage or RPC. Native code also increases build, memory-safety boundary and platform-maintenance risk.

## 11. Changes that do not require a protocol change

- physical-device clear-data/reinstall/backup/copy matrix;
- explicit production APK lifecycle test harness and evidence report;
- local storage generations, commit markers, cleanup and injected crash/failure tests;
- optional user authentication before retrieving the SecureStore wrapper secret;
- property tests, generated state models, fuzz targets and regression corpora;
- QR chaos tests and a non-economic resumable-frame cache;
- collusion/account-substitution tests;
- performance instrumentation and benchmark harnesses;
- operator secret-scanning and relayer custody procedures;
- clearer Portuguese recovery/claim-loss UX;
- platform capability telemetry that records no device identifier and grants no authority by itself.

These changes still require normal review because a storage migration can accidentally lock out valid sessions or expose a key, but they need not modify canonical signed bytes or economics.

## 12. Changes that require an ADR before implementation

| Proposed change | Why an ADR is mandatory |
|---|---|
| Replace Ed25519 device signer with P-256/Keystore/StrongBox signer | Changes algorithms, key representation, verification path, canonical objects and likely on-chain verification |
| Add hardware attestation evidence to authorization/certificate/claim | Adds trust roots, privacy/correlation, expiry/revocation and schema/version semantics |
| Make device identity permanent across sessions | Changes unlinkability, recovery and compromise blast radius |
| Add one-time hardware usage counters/keys as protocol evidence | Platform availability varies and it changes the authority/evidence model |
| Add an online anti-rollback counter/checkpoint required for offline access | Changes availability and offline trust assumptions |
| Change branch, aggregate exposure, coverage, allocation, revocation or settlement rules | Direct protocol/economic change |
| Modify canonical encoding/domain fields or signed object versions | Cross-language/on-chain compatibility change |
| Store partial QR data as claim/economic evidence | Changes acceptance semantics and is forbidden without a new proof model |

For the current Ed25519 protocol, a hardware-backed wrapping key may harden encryption-at-rest without changing signed schemas, but the Ed25519 seed would still become available to the app process during use. It must not be described as a non-exportable OGP signing identity.

## 13. Files expected in a future implementation

No file below is changed by this analysis. The likely future surface is:

### Existing production/source files

- `apps/payer-mobile/App.tsx`
- `apps/payer-mobile/app.json`
- `apps/payer-mobile/src/onchain-provisioning.ts`
- `apps/payer-mobile/src/onchain-recovery-controller.ts`
- `apps/payer-mobile/src/session-access.ts`
- `apps/merchant-mobile/App.tsx`
- `apps/merchant-mobile/app.json`
- `apps/merchant-mobile/src/claim-history.ts`
- `apps/merchant-mobile/src/claim-sync.ts`
- `apps/merchant-mobile/src/storage-scope.ts`
- `packages/transports/src/index.ts` only if resumable transport behavior is selected
- `package.json` and CI workflows for bounded test/benchmark commands

### Tests/new harnesses

- `tests/mobile/onchain-recovery-controller.test.ts`
- `tests/mobile/session-access.test.ts`
- `tests/mobile/onchain-provisioning.test.ts`
- `tests/mobile/claim-history.test.ts`
- `tests/mobile/claim-sync.test.ts`
- `tests/transports/qr-transport.test.ts`
- `tests/offline-ledger/ledger.test.ts`
- `tests/reconciliation/reconciliation.test.ts`
- `tests/runtime/validator.ts`
- new bounded directories such as `tests/property/`, `tests/adversarial/`, `tests/mobile-device/` and `benchmarks/mobile/`
- Rust math/program tests; fuzz-specific manifests only if approved after a lightweight-tool evaluation

### Documentation/ADR

- this analysis and the Sprint 8 report for execution evidence;
- a storage-hardening ADR if migration/commit semantics affect recoverability materially;
- a separate cryptographic device-identity ADR before any hardware-attested signer/schema change.

## 14. Risk-ordered implementation plan

This plan does not change the Prompt Master chronology and must begin only after approval.

1. **H0 — Freeze acceptance criteria and build the physical-device lifecycle matrix.** Test production entrypoint APK on both devices: clear data, uninstall/reinstall, partial restore, copied AsyncStorage, key loss, offline boot and online active-session recovery. Do not generate new APKs merely for UI changes.
2. **H1 — Crash-consistent storage.** Introduce generation/commit semantics, migration and injected failure at every write boundary for payer and merchant. Prove partial receive/write never becomes economic state.
3. **H2 — Device-key feasibility spike.** Record actual Keystore security level/attestation capabilities without using device identifiers. Compare (a) current SecureStore, (b) hardware-backed wrapper, and (c) non-exportable protocol signer. Stop before (c) changes code/schema; produce ADR options.
4. **H3 — Economic model properties.** Add bounded generators and state-machine invariants, led by total payout `<= cap`, invalid evidence adds zero liability and deterministic settlement across permutations.
5. **H4 — Claims/math/reconciliation fuzzing.** Add arbitrary parser input, generated DAGs, extrema and differential TS/Rust vectors with reproducible seeds and minimized regression cases.
6. **H5 — QR chaos.** Cover frame corruption, interruption, restart, resume, partial persistence, duplicates and storage failures. Keep partial frame state explicitly non-economic.
7. **H6 — Collusion suite.** Exercise payer+merchant, two merchants, cross-session/vault, recipient substitution, deliberate forks and concurrent replay.
8. **H7 — Real-device performance baseline.** Measure the defined operations on release builds; establish budgets from observed UX and security timeouts.
9. **H8 — Native decision.** Only after H7, choose `NO CHANGE`, targeted native primitive or broader native boundary. Any protocol signer change follows a separate accepted ADR.

Each stage must leave the existing suite green and add a concise evidence record. A discovered protocol/economic defect stops the stage and triggers an ADR proposal; it must not be silently patched by changing vectors or expected outputs.

## 15. Residual risks after hardening

Even a successful hardening phase will not eliminate:

- a fully compromised/rooted device invoking authorized signing operations or controlling the app UI;
- privileged rollback where both a usable key and complete old state can be restored without a trusted monotonic primitive;
- merchants losing unsubmitted claims through device loss when no encrypted recovery/export mechanism exists;
- payer/merchant collusion about a physical transaction the protocol cannot observe;
- denial of service, refusal to reconnect or refusal to submit claims;
- privacy correlation from public wallet, merchant, session, amount, time, account and claim-hash data;
- issuer, wallet, relayer-availability, RPC and supply-chain operational risks outside the offline proof core;
- hardware/platform fragmentation and devices without StrongBox or trustworthy attestation;
- bugs not reached by bounded fuzz/property budgets;
- economic unattractiveness of the required collateral ratio even when protocol solvency is preserved.

The accepted safety posture remains: prevent what the available trust boundary can prevent; detect authenticated divergence; revoke future offline access after a proven fork; and cap protocol liability by collateral in all settlements.

## 16. Hostile self-audit of this analysis

| Finding | Severity | Exploitability | Affected invariant | Evidence | Mitigation/status |
|---|---|---|---|---|---|
| Complete-old-snapshot rollback is locally self-consistent | High | Requires privileged snapshot/key capability | One local authority state should not be reused | Recovery validates integrity, not a trusted monotonic counter | **OPEN RISK**; demonstrate Sprint 9 fork and evaluate hardware/online checkpoints by ADR |
| Current OGP device seed is exportable to JS | High | App-process compromise, instrumentation or rooted device | Copying/signing authority should be difficult | `SecureStore.getItemAsync` returns the seed used by JS Ed25519 | **OPEN RISK**; feasibility spike, no false StrongBox claim |
| Payer three-part commit is fail-closed but not atomic | Medium | Crash/disk/storage failure | Partial state must never authorize spend | Ordered independent writes; partial presence rejected | **MITIGATED, NOT CLOSED**; add generation commit and failure injection |
| Merchant claim survival depends on local AsyncStorage | High availability / low solvency | Clear data, uninstall, device loss | Merchant must retain evidence until submission | No encrypted claim backup/export path | **OPEN RISK**; recovery design must not create duplicate liability |
| Cap property has fixed runtime evidence, not arbitrary-state proof | Critical assurance gap | Bugs in untested combinations | Total payout never exceeds cap | Fixed Rust/runtime scenarios only | **OPEN RISK**; H3/H4 are mandatory before stronger security claim |
| QR partial scanning is volatile | Low security / medium UX | App kill or interruption | Partial proof must not alter economics | Frames are in component memory until assembly | Safety **CLOSED**, resume availability **DEFERRED** |
| Hardware support can be overstated | High design risk | Incorrect platform assumption | Device identity non-exportability | StrongBox is optional and algorithm-limited | **OPEN RISK**; capability detection plus ADR/attestation verification |
| Demonstration behavior can be mistaken for production evidence | High assurance risk | Documentation/operational confusion | Clear-data must not restore authority | Demo fixture and production entrypoint are intentionally separate | **MITIGATED IN SOURCE**; physical production artifact gate remains |

### Confidence calibration

- **High confidence:** current source storage split, write order, fail-closed controller decisions, existing test inventory, transport parser behavior and current Ed25519 seed retrieval into JS.
- **Medium confidence:** exact Android OEM clear-data/backup behavior until verified on both physical devices and generated native manifests.
- **Low/undetermined:** StrongBox/attestation availability and algorithm support on the two actual devices; no capability probe or attestation chain has been collected.

## 17. Final gate

The analysis is **GO for the ordered hardening work** and **NO-GO for claiming completion or production device security today**.

Before implementation, approval is required for this plan. Approval of the plan does not authorize protocol/economic changes. Any result that requires a new signature algorithm, signed field, trust root, canonical encoding, settlement rule or collateral rule must return with an ADR proposal and stop for explicit review.

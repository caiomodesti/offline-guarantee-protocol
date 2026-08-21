# OGP security hardening — execution report

- Started: 2026-08-17
- Approved order: H0 -> H7
- Current gate: H3 economic property tests
- Overall status: **H0 PASS / H1 PASS / H2 PASS / H3 NEXT**
- Protocol/economic changes: none

## H0 — physical lifecycle matrix

### Gate result

**PASS for the H0 fail-closed device-storage gate.** Two physical Android devices confirmed that incomplete, restored or copied public state confers zero authority, while a complete tuple survives an offline restart. This is the real behavior required before H1.

Physical MWA proof against an authoritative public-cluster session is **DEFERRED — SPRINT 12**, not silently waived. MWA 2.0 does not identify localnet, the Prompt Master reserves devnet deployment for Sprint 12, and the existing validator path already proves the controller with an injected signer. Pulling devnet forward or presenting a fake local wallet as MWA proof would violate the immutable chronology.

### Evidence collected

| Check | Result | Evidence |
|---|---|---|
| Android toolchain discovery | PASS | ADB 36.0.0 and Android SDK are installed locally |
| Connected physical devices | PASS — TWO DISTINCT DEVICES | Device A: Samsung SM-G781B, Android 13 / SDK 33. Device B: Samsung SM-A236M, Android 14 / SDK 34. Both are physical ARM64 devices and were independently ADB-authorized on Android user 0 |
| Production entrypoint selected | PASS | `apps/payer-mobile/package.json` uses `index.ts`; no demo-manifest substitution was made |
| Current TypeScript/mobile suite | PASS | 24 test files / 124 tests passed; both mobile typechecks passed. The additional eight tests cover H0 probe isolation, selective-storage outcomes and scanner input bounds |
| Production Metro/Hermes bundle | PASS | Expo export produced a 3,011,562-byte Android HBC bundle from `apps/payer-mobile/index.ts`; SHA-256 `D2E04DF4E82ED218C9CA843288E0916803EDD5847B70E14A18E668F4AA1F198D` |
| Local Windows APK package | ENVIRONMENT NO-GO | CMake/Prefab cannot launch generated `.bat` paths under the workspace path containing spaces; this is distinct from the application bundle |
| Reproducible Linux APK build | PASS | Private GitHub Actions run `32090462706`, commit `95381a53e225b0e4ef7012868d185e7bcf88f0dd`, completed successfully in 17m58s; 23 test files / 116 tests passed and the hardened production-entrypoint arm64 artifact was uploaded |
| Artifact integrity | PASS | Final artifact ZIP: 26,119,205 bytes, SHA-256 `838C8F02A0BF4F403A0C7722525A46355203B3709D87EFEEE10BE2C891718511`, exactly matching GitHub's artifact digest |
| APK validation | PASS — H0 TEST BUILD | Final APK: 50,328,556 bytes, SHA-256 `6FB693CF091A77DE1B61333A1F91175FA890DEC1562218768DBBC369ECB9D140`; package `protocol.ogp.payer`; min SDK 24; target SDK 36; `arm64-v8a` only; `assets/index.android.bundle` present; APK Signature Scheme v2 verified |
| Android backup policy | PASS — CI + LOCAL STATIC + TWO-DEVICE LIFECYCLE | Final APK has `allowBackup=false` and no `fullBackupContent` or `dataExtractionRules`; cloud backup, automatic restore and device transfer are disabled for the payer. Clear-data and reinstall passed on both devices, and an explicit public-only state copy conferred zero authority on Device B |
| Android debug policy | PASS — STATIC | `android:debuggable` is absent from the release manifest and therefore defaults to false |
| Android permission minimization | PASS — CI + LOCAL STATIC | Final APK excludes overlay and external-storage permissions. Exact allowlist: camera, Internet, network state, biometric/fingerprint, vibration and the package-scoped non-exported receiver permission |
| Physical evidence harness | PASS — DEVICE A PROVEN | `scripts/h0-android-lifecycle.ps1` requires an explicit authorized physical-device serial, rejects emulators, verifies APK signature/package/arm64/SHA-256 sidecar and device ABI before installation, scopes destructive actions to `protocol.ogp.payer` and the active Android user, clears logcat before launch, refuses screenshots unless the payer is foreground, and captures device inventory, logcat and screenshot evidence |
| Clean install on Device A | PASS — NETWORK NOT CONTROLLED | Production APK installed on an empty user-0 package slot, showed `Conexão necessária`, and stated that no payment, session key or limit was recreated. Isolated startup log had no fatal/React Native crash. Offline boot remains a separate pending row |
| Clear data on Device A | PASS | `pm clear --user 0 protocol.ogp.payer` succeeded; payer returned to the same fail-closed recovery-required screen with no fatal startup evidence (`20260818T025510Z`) |
| Uninstall/reinstall on Device A | PASS | User-0 uninstall/reinstall succeeded with the verified APK SHA-256 `6FB693CF091A77DE1B61333A1F91175FA890DEC1562218768DBBC369ECB9D140`; payer returned fail-closed with no fatal startup evidence (`20260818T025559Z`) |
| Offline boot on Device A | PASS | During capture, airplane mode was enabled and both Wi-Fi and mobile data were `0`; payer remained on the recovery-required screen and recreated no authority. No fatal startup evidence was present. The pre-test network state was restored in `finally` (`20260818T025858Z`) |
| Clean install on Device B | PASS — NETWORK NOT CONTROLLED | The same authenticated APK installed on an empty user-0 package slot and returned to `Conexão necessária` with zero authority and no fatal startup evidence (`20260818T030338Z`) |
| Offline boot on Device B | PASS | Airplane mode was enabled and both Wi-Fi and mobile data were `0`; payer remained fail-closed, and the pre-test network state was restored in `finally` (`20260818T030507Z`) |
| Clear data on Device B | PASS | User-0 payer data was cleared; the app returned fail-closed with no fatal startup evidence (`20260818T030533Z`) |
| Uninstall/reinstall on Device B | PASS | The verified APK was reinstalled with the expected SHA-256; payer returned fail-closed with no fatal startup evidence and remained installed (`20260818T030601Z`) |
| Selective-storage instrumentation | PASS — CI APK + TWO PHYSICAL DEVICES | A separate `protocol.ogp.payer.h0` entrypoint seeded a deterministic valid tuple on Device A, deleted only SecureStore, restored only the AsyncStorage-equivalent public records, exported the exact public bytes by QR, and imported them on Device B. Production graph isolation and zero-authority outcomes are enforced by tests. Workflow `32095043653` built and verified its isolated release APK; the downloaded 50,329,116-byte APK has SHA-256 `7F54335E2B8359F2BB37DF721C53900E1A76FFB3DF696900B6688D36E756A18F` |
| Protected-key loss on Device A | PASS | Complete tuple produced `ATIVA — PROBE H0`; deleting only the protected key retained the public SHA-256 `00B976E980A51C0CF30F098E0A964F6DC5F395E5CC3EE58DA0163776DA5BEE21` but changed authority to `ZERO — FAIL-CLOSED` (`20260818T034243Z`, `20260818T034305Z`) |
| Public-only restore on Device A | PASS | Rewriting only the exact public records kept the same public hash, left the protected key absent and retained zero authority (`20260818T034334Z`) |
| Public copy Device A -> Device B | PASS | Device B scanned Device A's QR and reproduced the same public SHA-256 while the protected key remained absent and authority remained `ZERO — FAIL-CLOSED` (`20260818T034918Z`) |
| Complete local session offline boot | PASS — DEVICE B | A complete tuple remained `ATIVA — PROBE H0` after relaunch with Wi-Fi `0` and mobile data `0`; the probe performs no RPC. The rejected notification-shade screenshot was superseded by foreground evidence (`20260818T035042Z`, `20260818T035122Z`) |
| Online recovery with active session | **DEFERRED — SPRINT 12 PHYSICAL MWA** | Validator-backed controller proof already returns the deterministic active-session block. Production physical MWA/RPC/issuer proof requires a supported public cluster; the truthful UI remains fail-closed until that scheduled integration |

### Defect found and corrected

The first production bundle attempt failed because Metro did not resolve explicit NodeNext relative `.js` specifiers to their TypeScript sources. The shared build correctly requires the `.js` specifiers, so removing them would break the root NodeNext compilation. A payer-specific Metro resolver now performs only that narrow source mapping and preserves default behavior for packages and real JavaScript files. After the correction, `corepack pnpm check` passed 116 TypeScript tests, six unchanged golden vectors, the Rust cross-language vector test and all 16 program host tests.

This is a mobile build integration correction. It does not alter canonical bytes, signatures, keys, session rules, reconciliation, settlement or economics.

The first physical run also exposed four harness-only defects: PowerShell array matching could reject valid multiline `aapt` output; Samsung multi-user package queries required an explicit Android user; PowerShell consumed Android's `-p` argument; and a screenshot could be accepted after another app took focus. The harness now joins `aapt` output before matching, resolves and scopes all lifecycle operations to the active Android user, launches the resolved activity with `am start`, clears the log window, and refuses capture unless `protocol.ogp.payer` is the top resumed activity. One superseded capture showed another finance app and was explicitly rejected; it is not acceptance evidence.

The selective-storage probe is deliberately a different Android package and entrypoint. `index.ts` cannot reach `App.h0.tsx`, `index.h0.ts`, `h0-lifecycle-probe.ts` or `dev-session.ts`; graph tests fail if that boundary changes. Its QR envelope contains only provisioning and branch JSON, rejects extra fields, excludes the protected device secret, and is capped by test below the QR byte-mode limit. The probe never performs RPC and reports economic authority only when the same recovery controller accepts the complete signed tuple.

### Windows build limitation

The full local Gradle package also failed in Expo/Nitro CMake configuration because generated Prefab commands live below the physical workspace path containing spaces. A temporary drive alias did not help: pnpm dependency links resolve back to the physical path. The production JS/Hermes bundle passed independently. The reproducible APK path is the Linux GitHub Actions workflow, matching the project's existing Android artifact process.

### CI APK proof

The initial GitHub Actions run `31992215121`, commit `8a3091c34c9617b74bdd001cb84218f602a6b3f1`, completed successfully and established the first production-entrypoint artifact. After manifest hardening, final run `32090462706`, commit `95381a53e225b0e4ef7012868d185e7bcf88f0dd`, passed the complete source suite and the strengthened artifact verifier. The downloaded final ZIP digest exactly matched the digest published by GitHub, and the final APK hash exactly matched the `.sha256` sidecar generated inside the trusted job.

Selective-storage workflow `32095043653`, commit `45b04f9997d1a99bd713f806e581b3cf9dfb2aa7`, completed both the production-entrypoint and lifecycle-instrumentation jobs successfully. The isolated artifact was published as `security-hardening-h0-payer-lifecycle-instrumentation-arm64`; its downloaded APK is 50,329,116 bytes with SHA-256 `7F54335E2B8359F2BB37DF721C53900E1A76FFB3DF696900B6688D36E756A18F`, exactly matching its job-generated sidecar. Local verification independently accepted the exact package `protocol.ogp.payer.h0`, signature, release/debug policy, ARM64 ABI, bundle, backup policy and permission allowlist.

The APK is signed by the automatically generated Android debug certificate (`SHA-256 FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C`) even though Gradle used the release build variant. This is acceptable only for the H0 physical lifecycle test. It is explicitly **not** a production/distribution signing decision.

The run emitted one non-blocking CI maintenance warning: current `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4` target the deprecated Node.js 20 action runtime and were forced to Node.js 24 by the runner. The build and all verification steps passed; action-major upgrades remain a separate reviewed maintenance change.

The first compiled H0 manifest was inspected directly. It had `allowBackup=true`, while `secure_store_backup_rules` and `secure_store_data_extraction_rules` included only the `sharedpref` domain and excluded the `SecureStore` preference file for both cloud backup and device transfer. No database, file or root domain was included, so Android's automatic restore could not restore the AsyncStorage database or protected SecureStore material.

The static result was safe for the observed stores but unnecessarily depended on an exclusion list. H0 therefore adopts the simpler device-security rule `android.allowBackup=false` for the payer and disables generated backup/extraction rules. Future APK verification fails if backup is enabled, if either backup rule is referenced, or if the release is debuggable. This does not replace the explicit adversarial "restore AsyncStorage only" injection: an attacker or test harness may still copy public state through channels outside Android Auto Backup, and that state must confer zero authority without the protected key.

The first APK also inherited `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` from the Expo base template. None is required for the payer's QR camera flow, protected local state or network recovery. H0 blocks all three in the final merged manifest and makes their absence a CI assertion. Camera, Internet, network-state and SecureStore biometric permissions remain because they correspond to explicit payer functions.

### Physical matrix — H0 execution complete

| Scenario | Device A | Device B | Required result |
|---|---|---|---|
| Clean production install | PASS — fail-closed; network not controlled | PASS — fail-closed; network not controlled | Recovery required; zero offline authority recreated |
| Offline boot without a valid local session | PASS | PASS | Recovery required; zero offline authority recreated |
| Clear data | PASS | PASS | Recovery required; no balance/session recreated |
| Uninstall/reinstall | PASS | PASS | Recovery required; no balance/session recreated |
| Lose SecureStore key only | PASS — zero authority | Not repeated; source invariant shared | Partial public record rejected |
| Restore AsyncStorage only | PASS — zero authority | PASS through cross-device import | Partial public record rejected |
| Copy public state A -> B | PASS — exported exact bytes | PASS — same hash, zero authority | Device B cannot spend without matching protected key |
| Complete valid local session, offline boot | Not repeated | PASS after copy/reseed | Exact signed branch restored without RPC |
| Active on-chain session after local loss | DEFERRED — Sprint 12 physical MWA | DEFERRED — Sprint 12 physical MWA | Validator proof blocks fresh capacity; public-cluster physical MWA proof remains scheduled |

### Deferred evidence that does not reorder H1

1. Compile/test the concrete MWA/RPC/certificate-issuer boundary during the already-authorized Sprint 8 integration work.
2. Execute its physical public-cluster proof in Sprint 12, when devnet deployment is authorized. Until then, a blocked informational screen is not described as recovery proof.

### Reproducible physical commands

The harness never chooses a device implicitly. Replace `<serial>` with a serial shown as `device` by `adb devices -l`, and replace `<apk>` with the locally verified CI artifact:

```powershell
.\scripts\h0-android-lifecycle.ps1 -Action Inventory -Serial '<serial>'
.\scripts\h0-android-lifecycle.ps1 -Action Install -Serial '<serial>' -ApkPath '<apk>'
.\scripts\h0-android-lifecycle.ps1 -Action ClearData -Serial '<serial>'
.\scripts\h0-android-lifecycle.ps1 -Action UninstallReinstall -Serial '<serial>' -ApkPath '<apk>'
```

The isolated selective-storage probe uses the same harness with an explicit target; the default target remains the production payer:

```powershell
.\scripts\h0-android-lifecycle.ps1 -Target H0Probe -Action Install -Serial '<serial>' -ApkPath '<h0-probe-apk>'
.\scripts\h0-android-lifecycle.ps1 -Target H0Probe -Action Launch -Serial '<serial>'
.\scripts\h0-android-lifecycle.ps1 -Target H0Probe -Action Capture -Serial '<serial>'
```

Physical sequence after the CI artifact passes:

1. On Device A, seed the valid tuple and capture `ATIVA — PROBE H0` plus its public SHA-256.
2. Delete only the protected key and capture `ZERO — FAIL-CLOSED` while public state remains present.
3. Restore public state only and capture the same zero-authority result.
4. Display Device A's public-copy QR, import it on Device B, compare the SHA-256 values and require `ZERO — FAIL-CLOSED` on Device B.

The currently verified APK path is git-ignored and local-only:

```text
artifacts/security-hardening/h0/ci-run-32090462706/extracted/app-release.apk
artifacts/security-hardening/h0/ci-run-32095043653/instrumentation/app-release.apk
```

Evidence is written under the git-ignored `artifacts/security-hardening/h0/devices/<serial>/<UTC timestamp>/` directory. The Device A offline proof used a one-shot operator-controlled wrapper that recorded the before/during/after network state and restored it in `finally`; the committed lifecycle harness itself does not silently change airplane mode, Wi-Fi, mobile data or wallet state.

### H0 decision

**PASS / H1 AUTHORIZED.** Devices A and B prove fail-closed behavior for clean install, offline boot, clear data, user-scoped uninstall/reinstall, protected-key loss, public-only restore and an exact cross-device public-state copy. A complete local tuple also survived a no-network relaunch. Physical public-cluster MWA recovery remains explicitly deferred to Sprint 12; this preserves rather than changes the Prompt Master chronology.

## H1 — crash-consistent local storage

### Gate result

**PASS.** Production payer and merchant state now uses serialized, generation-bound transactions across AsyncStorage and SecureStore. No component becomes authoritative until the public committed manifest is published, and that manifest is accepted only when its generation is bound by the protected current/pending journal.

ADR-0020 records this local-storage architecture. It changes no protocol economics or signed bytes.

### Implemented design

The new `@ogp/mobile-storage` package provides strict local envelopes, SHA-256 payload integrity, random 32-byte generation IDs, a public prepared/committed manifest pair and a protected current/pending journal. For the three-component payer and merchant snapshots, the write sequence is:

```text
1  public prepared manifest
2  protected journal(old current, new pending)
3  public component A
4  public component B
5  protected component C
6  public committed manifest
7  protected journal(new current, no pending)
8  prepared-manifest cleanup
```

The authority boundary is step 6. Failures at steps 1-6 either confer zero authority for an initial write or preserve the previous complete generation for an update. Failures at steps 7-8 return success with cleanup pending, because the exact transaction is already published; the next load deterministically completes recovery instead of encouraging an economic retry.

Payer transactions contain confirmed provisioning, branch/proof state and the protected device secret. The payer persists a new proof before updating the displayed balance or QR. It rereads the durable protected secret before signing and serializes concurrent commits.

Merchant transactions contain the full claim queue, outstanding challenge and protected device identity. Receipt of a valid proof atomically adds/deduplicates the claim and removes the exact outstanding challenge. Receipt-display and claim-sync metadata use the same serialized store. Public legacy merchant state without its protected identity is rejected.

### Fault-injection and corruption evidence

| Scenario | Expected authority | Result |
|---|---|---|
| initial commit fails at any write 1-6 | none | PASS |
| update fails at any write 1-6 | previous generation only | PASS |
| protected-journal finalization fails after public commit | new complete generation; cleanup pending | PASS |
| prepared cleanup fails after public commit | new complete generation; cleanup pending | PASS |
| component from another generation is substituted | fail closed | PASS |
| payload changes without manifest hash update | fail closed | PASS |
| public committed pointer is rolled back | fail closed against protected current generation | PASS |
| public committed pointer is deleted | fail closed while protected current exists | PASS |
| public-only snapshot lacks protected journal | fail closed | PASS |
| durable payer state is corrupt while legacy records exist | fail closed; no legacy fallback | PASS |
| payer commits race | serialized; second complete generation wins | PASS |
| merchant updates race | serialized; neither update is lost | PASS |
| evidence insertion and challenge removal is interrupted | previous complete pair only | PASS |

The H1-focused suite contains 17 tests. The complete repository check passed:

- 27 TypeScript test files / 141 tests;
- payer and merchant strict typechecks;
- production Metro/Hermes export for both Android entrypoints: payer 3,031,482 bytes, SHA-256 `8DDE2ABE7925904AAC1AE9A9CD993F14FEA9C1E2F6BE486039A2BD4BBEE81E79`; merchant 3,789,272 bytes, SHA-256 `5E6944716123880CE2BF870E3AB242C490C46929623397E075F103553974E305`;
- six golden vectors verified without modification;
- one Rust cross-language Borsh/SHA-256/Ed25519 conformance test;
- 16 program host tests.

### H1 findings and mitigations

1. **Public-only generation pointer — HIGH design weakness found before release.** A public pointer could have selected an older protected component retained on the same device. The protected current/pending journal now binds the accepted generation and makes public rollback fail closed. Status: CLOSED for public-only rollback.
2. **Payer signing read bypass — HIGH functional defect found during audit.** The first adapter revision restored the durable secret but the signing path still reread the legacy SecureStore key. Signing now loads the protected secret through the same durable adapter. Status: CLOSED.
3. **Concurrent transaction interleaving — MEDIUM.** Payer commits and merchant read-modify-write operations could otherwise overlap. Both adapters now serialize operations. Status: CLOSED.
4. **Merchant evidence/challenge split write — HIGH.** The pre-H1 flow wrote a claim and removed its challenge independently. They are now one snapshot commit. Status: CLOSED.

### Remaining H1 limitations

- Individual storage calls are assumed to either resolve or reject. Cross-store atomicity is not assumed.
- Historical immutable component envelopes are not garbage-collected in H1. This is safe but may grow merchant storage; measurement and a separately fault-tested retention policy are required before optimization.
- A rooted attacker who can roll back or extract both public and protected stores remains outside a software-only guarantee and stays an OPEN RISK.
- The explicit Sprint 7 payer fixture and isolated H0 probe remain non-production graphs. Production dependency-graph tests require the H1 adapters.
- No new H1 APK was installed; the user explicitly deferred APK generation/installation while development continues. H0 physical evidence remains valid, and a future physical build must exercise the production H1 graph before device-security GO.

### H1 decision

**PASS / H2 AUTHORIZED.** Crash consistency and public/protected generation binding are proven at every modeled write boundary. Overall device security remains **NO-GO** until H2 feasibility evidence and later hardening gates are complete.

## H2 — device-key feasibility spike

### Current gate result

**PASS — source audit, isolated measurement harness and two-device physical capability matrix complete.** ADR-0021 fixes the research boundary and selects no new production signer. H3 is authorized.

### Current SecureStore evidence

Both mobile applications lock `expo-secure-store@57.0.1`. The inspected Android AES implementation has SHA-256 `D3A86DE25C64935E84B6999101556B0E9F8BC6C90CE7600C421125B3E18AA3F4`; the installed package manifest has SHA-256 `B0E229328F8389175825CD43DFDFE2AAE482D9DCE6DBCA6BEE480FDCDB7B81EC`.

Source inspection proves that SecureStore creates an AES-256-GCM wrapper in `AndroidKeyStore`, optionally gated by `requireAuthentication`. OGP does not set that option. This dependency version neither requests StrongBox nor records `KeyInfo` security level or an attestation challenge. Android ignores the iOS-oriented `WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility value because Android's native options expose only the authentication prompt, keychain service and authentication requirement.

The OGP Ed25519 seed is decrypted and returned to JavaScript for signing. It is therefore a software protocol signer protected at rest, not a non-exportable hardware-backed OGP signer. The actual hardware level of the AES wrapper is still a physical measurement, not a source-code fact.

### Isolated capability probe

The standalone `protocol.ogp.h2probe` APK measures default Android Keystore and requested-StrongBox AES-256-GCM, attested P-256 signing and experimental Ed25519 provider support. It records actual `KeyInfo` security level and functional results, then deletes every ephemeral alias. It never signs OGP bytes and is unreachable from the payer and merchant entrypoints.

Static and APK verification results:

| Property | Result |
|---|---|
| Device A / Device B build timestamps | `20260821T013305Z` / `20260821T014422Z` |
| APK size | 16,787 bytes |
| Device A / Device B APK SHA-256 | `C8F31F332E044EC910DF41E25A6EF174888B19F4059265EA08911B70FBE3AAA7` / `5100D51A2FA4B5CDEDE99E767F54A71ED6C5AFBE3D7AEC2E4DC723ADB939EB76` |
| Package/version | `protocol.ogp.h2probe` / `1` / `0.1.0-h2` |
| SDK | min 23 / target 36 |
| Permissions | none; no Internet permission |
| Backup/debug | `allowBackup=false`; `debuggable=false` |
| APK signature verification | v1, v2 and v3 PASS; ephemeral probe-only certificate |
| Pre-install controls | Exact package, signature, no permissions, backup/debug policy and build SHA-256 sidecar are reverified; explicit physical serial required; emulator rejected |
| Data emitted | Device label/model/OS, capability booleans, security levels and functional outcomes; no serial, Android ID, raw key, certificate or attestation record. Host accepts only complete label-bound JSON and writes a SHA-256 sidecar |
| Protocol effect | none |

The Java 8 compilation emits a non-blocking bootstrap-classpath warning under JDK 17 and a deprecation notice because pre-API-31 devices require the legacy `KeyInfo.isInsideSecureHardware()` compatibility path. D8, packaging, alignment and signature verification pass.

The complete host/conformance suite passes after the H2 harness addition: root and both mobile TypeScript checks, 29 test files / 148 tests, six unchanged golden vectors, one Rust cross-language vector test and 16 program host tests. The added regression tests pin the audited SecureStore version/source assumptions, current no-authentication production setting, probe isolation, both normalized physical results and pre-install artifact controls.

### Physical capability matrix

Both devices were measured on 2026-08-21 UTC. Device A raw validated JSON has SHA-256 `6F33027D9C204EF117161BD9ABD85BC290395F545EAF99D68126D0CF6CD0B58A`; Device B raw validated JSON has SHA-256 `5B1A4F6102D6ED9F99745E0697ADACD92D6432823BB5FDEFC033F1A9DB8A46A0`. Normalized, non-identifying semantic copies are committed under `docs/evidence/h2/` and guarded by regression tests.

| Measurement | Device A | Device B |
|---|---|---|
| StrongBox feature advertised | PASS — true | PASS — false; optional capability correctly absent |
| AES default actual security level and round-trip | PASS — TEE, non-exportable, round-trip true | PASS — TEE, non-exportable, round-trip true |
| AES requested StrongBox actual result | PASS — StrongBox, non-exportable, round-trip true | UNSUPPORTED — feature absent |
| P-256 default sign/verify and attestation-extension presence | PASS — TEE, non-exportable, sign/verify true, chain 4, extension present | PASS — TEE, non-exportable, sign/verify true, chain 4, extension present |
| P-256 requested StrongBox actual result | PASS — StrongBox, non-exportable, sign/verify true, chain 4, extension present | UNSUPPORTED — feature absent |
| Ed25519 AndroidKeyStore default actual result | UNSUPPORTED — `NoSuchAlgorithmException` | UNSUPPORTED — `NoSuchAlgorithmException` |
| Ed25519 requested StrongBox actual result | UNSUPPORTED — `NoSuchAlgorithmException` | UNSUPPORTED — feature absent |

The first Device A install attempted ADB incremental delivery, which that Samsung package manager explicitly disallowed; ADB safely retried as a streamed install and succeeded. The harness now passes `--no-incremental` explicitly so subsequent evidence runs avoid this environment-dependent fallback. This was a harness-only finding and did not affect the measurement or OGP state. The probe package was uninstalled after capture.

Device A confirms that hardware-backed P-256/StrongBox is technically feasible on at least one target device. Device B proves that StrongBox cannot be mandatory for the present device population. Both prove that AndroidKeyStore Ed25519 cannot be assumed. This does not justify a signer migration: current SecureStore wrapper aliases were not directly introspected, attestation was not verified off-device, and a P-256 migration would still change protocol schemas and verification paths.

Attestation-extension presence is only a capability signal. A production trust decision would require off-device validation of the chain, Google root, challenge, security level and revocation state. No such trust system is introduced in H2.

### H2 decision boundary

- v0.1 keeps its existing Ed25519 signer and canonical objects unchanged;
- current SecureStore protection is described accurately as encryption at rest with a Keystore wrapper;
- `requireAuthentication`, an explicitly measured wrapper and non-exportable P-256/attestation are separate future options, not silent upgrades;
- any signer algorithm, signed-schema or attestation-protocol change requires a new ADR and explicit approval;
- H2 passes with the two-device matrix captured; H3 may start after this reviewed branch is integrated.

### H2 decision

**PASS / H3 AUTHORIZED.** Current Ed25519 remains unchanged for MVP. TEE-based wrapping is feasible on both tested devices, StrongBox is optional and fragmented, and non-exportable protocol signing/attestation remain deferred behind a new ADR and explicit approval. Overall device security remains **NO-GO** until H3-H7 complete.

## H3-H7

H3 is next. H4-H7 have not started. The approved order remains preserved.

## Protocol preservation audit

- `collateral_coverage_cap`: unchanged
- branch economics and aggregate exposure: unchanged
- settlement/reconciliation/revocation/payout: unchanged
- canonical schemas and signed objects: unchanged
- domain separation and Ed25519: unchanged
- golden vectors: unchanged
- NFC, Spend Notes, attestation protocol, new signer and Rust/JSI/FFI: not started

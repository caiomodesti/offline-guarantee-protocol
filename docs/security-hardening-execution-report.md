# OGP security hardening — execution report

- Started: 2026-08-17
- Approved order: H0 -> H7
- Current gate: H0
- Overall status: **NO-GO / IN PROGRESS**
- Protocol/economic changes: none

## H0 — physical lifecycle matrix

### Gate result

H0 is not complete. H1-H7 have not started because the authorization explicitly requires real fail-closed confirmation before continuing.

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
| Android backup policy | PASS — CI + LOCAL STATIC + TWO-DEVICE LIFECYCLE | Final APK has `allowBackup=false` and no `fullBackupContent` or `dataExtractionRules`; cloud backup, automatic restore and device transfer are disabled for the payer. Clear-data and reinstall behavior passed on both devices; selective public-store injection remains pending |
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
| Selective-storage instrumentation source | PASS — APK PENDING | A separate `protocol.ogp.payer.h0` entrypoint can seed a deterministic valid tuple, delete only SecureStore, restore only the AsyncStorage-equivalent public records, export the exact public bytes by QR, and import them on another device. Production graph isolation and zero-authority outcomes are enforced by tests |
| Online recovery with active session | **NO-GO — INTEGRATION GAP** | Production UI currently shows a truthful recovery-required screen but has no concrete MWA/RPC/issuer adapter wired behind it |

### Defect found and corrected

The first production bundle attempt failed because Metro did not resolve explicit NodeNext relative `.js` specifiers to their TypeScript sources. The shared build correctly requires the `.js` specifiers, so removing them would break the root NodeNext compilation. A payer-specific Metro resolver now performs only that narrow source mapping and preserves default behavior for packages and real JavaScript files. After the correction, `corepack pnpm check` passed 116 TypeScript tests, six unchanged golden vectors, the Rust cross-language vector test and all 16 program host tests.

This is a mobile build integration correction. It does not alter canonical bytes, signatures, keys, session rules, reconciliation, settlement or economics.

The first physical run also exposed four harness-only defects: PowerShell array matching could reject valid multiline `aapt` output; Samsung multi-user package queries required an explicit Android user; PowerShell consumed Android's `-p` argument; and a screenshot could be accepted after another app took focus. The harness now joins `aapt` output before matching, resolves and scopes all lifecycle operations to the active Android user, launches the resolved activity with `am start`, clears the log window, and refuses capture unless `protocol.ogp.payer` is the top resumed activity. One superseded capture showed another finance app and was explicitly rejected; it is not acceptance evidence.

The selective-storage probe is deliberately a different Android package and entrypoint. `index.ts` cannot reach `App.h0.tsx`, `index.h0.ts`, `h0-lifecycle-probe.ts` or `dev-session.ts`; graph tests fail if that boundary changes. Its QR envelope contains only provisioning and branch JSON, rejects extra fields, excludes the protected device secret, and is capped by test below the QR byte-mode limit. The probe never performs RPC and reports economic authority only when the same recovery controller accepts the complete signed tuple.

### Windows build limitation

The full local Gradle package also failed in Expo/Nitro CMake configuration because generated Prefab commands live below the physical workspace path containing spaces. A temporary drive alias did not help: pnpm dependency links resolve back to the physical path. The production JS/Hermes bundle passed independently. The reproducible APK path is the Linux GitHub Actions workflow, matching the project's existing Android artifact process.

### CI APK proof

The initial GitHub Actions run `31992215121`, commit `8a3091c34c9617b74bdd001cb84218f602a6b3f1`, completed successfully and established the first production-entrypoint artifact. After manifest hardening, final run `32090462706`, commit `95381a53e225b0e4ef7012868d185e7bcf88f0dd`, passed the complete source suite and the strengthened artifact verifier. The downloaded final ZIP digest exactly matched the digest published by GitHub, and the final APK hash exactly matched the `.sha256` sidecar generated inside the trusted job.

The APK is signed by the automatically generated Android debug certificate (`SHA-256 FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C`) even though Gradle used the release build variant. This is acceptable only for the H0 physical lifecycle test. It is explicitly **not** a production/distribution signing decision.

The run emitted one non-blocking CI maintenance warning: current `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4` target the deprecated Node.js 20 action runtime and were forced to Node.js 24 by the runner. The build and all verification steps passed; action-major upgrades remain a separate reviewed maintenance change.

The first compiled H0 manifest was inspected directly. It had `allowBackup=true`, while `secure_store_backup_rules` and `secure_store_data_extraction_rules` included only the `sharedpref` domain and excluded the `SecureStore` preference file for both cloud backup and device transfer. No database, file or root domain was included, so Android's automatic restore could not restore the AsyncStorage database or protected SecureStore material.

The static result was safe for the observed stores but unnecessarily depended on an exclusion list. H0 therefore adopts the simpler device-security rule `android.allowBackup=false` for the payer and disables generated backup/extraction rules. Future APK verification fails if backup is enabled, if either backup rule is referenced, or if the release is debuggable. This does not replace the explicit adversarial "restore AsyncStorage only" injection: an attacker or test harness may still copy public state through channels outside Android Auto Backup, and that state must confer zero authority without the protected key.

The first APK also inherited `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` from the Expo base template. None is required for the payer's QR camera flow, protected local state or network recovery. H0 blocks all three in the final merged manifest and makes their absence a CI assertion. Camera, Internet, network-state and SecureStore biometric permissions remain because they correspond to explicit payer functions.

### Physical matrix — execution in progress

| Scenario | Device A | Device B | Required result |
|---|---|---|---|
| Clean production install | PASS — fail-closed; network not controlled | PASS — fail-closed; network not controlled | Recovery required; zero offline authority recreated |
| Offline boot without a valid local session | PASS | PASS | Recovery required; zero offline authority recreated |
| Clear data | PASS | PASS | Recovery required; no balance/session recreated |
| Uninstall/reinstall | PASS | PASS | Recovery required; no balance/session recreated |
| Lose SecureStore key only | SOURCE PASS — physical probe pending | SOURCE PASS — physical probe pending | Partial public record rejected |
| Restore AsyncStorage only | SOURCE PASS — physical probe pending | SOURCE PASS — physical probe pending | Partial public record rejected |
| Copy public state A -> B | Source/export implementation ready | Import implementation ready | Device B cannot spend without matching protected key |
| Complete valid local session, offline boot | PENDING | PENDING | Exact signed branch restored without RPC |
| Active on-chain session after local loss | BLOCKED | BLOCKED | Fresh capacity blocked; concrete MWA/RPC recovery still needs integration |

### H0 blockers

1. Build and verify the isolated `protocol.ogp.payer.h0` APK in CI, then execute SecureStore loss, public-only restore and QR copy on Devices A and B.
2. Complete the already-documented Sprint 8 MWA/RPC/certificate-issuer adapter before the active-session online-recovery row can be physically tested. A blocked informational screen is not recovery proof.

### Reproducible physical commands

The harness never chooses a device implicitly. Replace `<serial>` with a serial shown as `device` by `adb devices -l`, and replace `<apk>` with the locally verified CI artifact:

```powershell
.\scripts\h0-android-lifecycle.ps1 -Action Inventory -Serial '<serial>'
.\scripts\h0-android-lifecycle.ps1 -Action Install -Serial '<serial>' -ApkPath '<apk>'
.\scripts\h0-android-lifecycle.ps1 -Action ClearData -Serial '<serial>'
.\scripts\h0-android-lifecycle.ps1 -Action UninstallReinstall -Serial '<serial>' -ApkPath '<apk>'
```

The currently verified APK path is git-ignored and local-only:

```text
artifacts/security-hardening/h0/ci-run-32090462706/extracted/app-release.apk
```

Evidence is written under the git-ignored `artifacts/security-hardening/h0/devices/<serial>/<UTC timestamp>/` directory. The Device A offline proof used a one-shot operator-controlled wrapper that recorded the before/during/after network state and restored it in `finally`; the committed lifecycle harness itself does not silently change airplane mode, Wi-Fi, mobile data or wallet state.

### H0 decision

**NO-GO / TWO-DEVICE LIFECYCLE PASS.** Devices A and B independently prove fail-closed behavior for clean install, offline boot, clear data and user-scoped uninstall/reinstall. Protected/public-store asymmetry, meaningful cross-device state copying and live active-session recovery remain incomplete. Per the approved sequence, H1-H7 remain gated.

## H1-H7

Not started. This is intentional and preserves the approved H0-first rule.

## Protocol preservation audit

- `collateral_coverage_cap`: unchanged
- branch economics and aggregate exposure: unchanged
- settlement/reconciliation/revocation/payout: unchanged
- canonical schemas and signed objects: unchanged
- domain separation and Ed25519: unchanged
- golden vectors: unchanged
- NFC, Spend Notes, attestation protocol, new signer and Rust/JSI/FFI: not started

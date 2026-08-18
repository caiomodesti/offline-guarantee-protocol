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
| Connected physical devices | **NO-GO** | `adb devices -l` returned an empty device list |
| Production entrypoint selected | PASS | `apps/payer-mobile/package.json` uses `index.ts`; no demo-manifest substitution was made |
| TypeScript/mobile suite after H0 resolver change | PASS | 23 test files / 116 tests passed; both mobile typechecks passed |
| Production Metro/Hermes bundle | PASS | Expo export produced a 3,011,562-byte Android HBC bundle from `apps/payer-mobile/index.ts`; SHA-256 `D2E04DF4E82ED218C9CA843288E0916803EDD5847B70E14A18E668F4AA1F198D` |
| Local Windows APK package | ENVIRONMENT NO-GO | CMake/Prefab cannot launch generated `.bat` paths under the workspace path containing spaces; this is distinct from the application bundle |
| Reproducible Linux APK build | PASS | Private GitHub Actions run `31992215121` completed successfully in 17m55s; 23 test files / 116 tests passed and the production-entrypoint arm64 artifact was uploaded |
| Artifact integrity | PASS | Artifact ZIP: 26,119,300 bytes, SHA-256 `6552000D0F5837A8661279ED2483E33DF3914A9D4BCD0716068A170893C5D7D2`, exactly matching GitHub's artifact digest |
| APK validation | PASS — H0 TEST BUILD | APK: 50,328,656 bytes, SHA-256 `AEB108722FF7D5819E1F9BA3B8F713E4F1D486899E735BD2D3B9E4AAEBE0C24F`; package `protocol.ogp.payer`; min SDK 24; target SDK 36; `arm64-v8a` only; `assets/index.android.bundle` present; APK Signature Scheme v2 verified |
| Android backup policy | PASS — STATIC | `allowBackup=true`, but both legacy backup and Android 12+ extraction rules allow only shared preferences and explicitly exclude `SecureStore`; no database/file/root domain is included. Physical restore behavior remains pending H0 evidence |
| Android debug policy | PASS — STATIC | `android:debuggable` is absent from the release manifest and therefore defaults to false |
| Physical evidence harness | PASS — READY | `scripts/h0-android-lifecycle.ps1` requires an explicit authorized physical-device serial, rejects emulators, scopes destructive actions to `protocol.ogp.payer`, and captures device inventory, logcat and screenshot evidence |
| Clear-data/reinstall matrix | PENDING | Requires the payer APK plus two ADB-authorized devices |
| Online recovery with active session | **NO-GO — INTEGRATION GAP** | Production UI currently shows a truthful recovery-required screen but has no concrete MWA/RPC/issuer adapter wired behind it |

### Defect found and corrected

The first production bundle attempt failed because Metro did not resolve explicit NodeNext relative `.js` specifiers to their TypeScript sources. The shared build correctly requires the `.js` specifiers, so removing them would break the root NodeNext compilation. A payer-specific Metro resolver now performs only that narrow source mapping and preserves default behavior for packages and real JavaScript files. After the correction, `corepack pnpm check` passed 116 TypeScript tests, six unchanged golden vectors, the Rust cross-language vector test and all 16 program host tests.

This is a mobile build integration correction. It does not alter canonical bytes, signatures, keys, session rules, reconciliation, settlement or economics.

### Windows build limitation

The full local Gradle package also failed in Expo/Nitro CMake configuration because generated Prefab commands live below the physical workspace path containing spaces. A temporary drive alias did not help: pnpm dependency links resolve back to the physical path. The production JS/Hermes bundle passed independently. The reproducible APK path is the Linux GitHub Actions workflow, matching the project's existing Android artifact process.

### CI APK proof

GitHub Actions run `31992215121`, commit `8a3091c34c9617b74bdd001cb84218f602a6b3f1`, completed successfully. The downloaded ZIP digest exactly matched the digest published by GitHub, and the APK hash exactly matched the `.sha256` sidecar generated inside the trusted job.

The APK is signed by the automatically generated Android debug certificate (`SHA-256 FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C`) even though Gradle used the release build variant. This is acceptable only for the H0 physical lifecycle test. It is explicitly **not** a production/distribution signing decision.

The run emitted one non-blocking CI maintenance warning: current `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4` target the deprecated Node.js 20 action runtime and were forced to Node.js 24 by the runner. The build and all verification steps passed; action-major upgrades remain a separate reviewed maintenance change.

The compiled manifest was also inspected directly. `allowBackup=true`, while `secure_store_backup_rules` and `secure_store_data_extraction_rules` include only the `sharedpref` domain and exclude the `SecureStore` preference file for both cloud backup and device transfer. No database, file or root domain is included, so Android's automatic restore cannot restore the AsyncStorage database or the protected SecureStore material. This supports fail-closed reinstall behavior but does not replace the required physical tests or the explicit adversarial "restore AsyncStorage only" injection. Future H0 builds now assert these rules and non-debuggability in CI.

### Physical matrix — pending execution

| Scenario | Device A | Device B | Required result |
|---|---|---|---|
| Clean production install, offline boot | PENDING | PENDING | Recovery required; zero offline authority recreated |
| Clear data | PENDING | PENDING | Recovery required; no balance/session recreated |
| Uninstall/reinstall | PENDING | PENDING | Recovery required; no balance/session recreated |
| Lose SecureStore key only | PENDING | PENDING | Partial public record rejected |
| Restore AsyncStorage only | PENDING | PENDING | Partial public record rejected |
| Copy public state A -> B | PENDING | PENDING | Device B cannot spend without matching protected key |
| Complete valid local session, offline boot | PENDING | PENDING | Exact signed branch restored without RPC |
| Active on-chain session after local loss | BLOCKED | BLOCKED | Fresh capacity blocked; concrete MWA/RPC recovery still needs integration |

### H0 blockers

1. Connect and authorize both Android devices over USB debugging so they appear in `adb devices -l`.
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
artifacts/security-hardening/h0/ci-run-31992215121/extracted/app-release.apk
```

Evidence is written under the git-ignored `artifacts/security-hardening/h0/devices/<serial>/<UTC timestamp>/` directory. Network-off and recovery actions remain operator-observed steps: the harness does not silently change airplane mode, Wi-Fi, mobile data or wallet state.

### H0 decision

**NO-GO.** The source logic and production bundle support the fail-closed model, but the required physical lifecycle evidence does not yet exist. Per the approved sequence, H1-H7 remain gated.

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

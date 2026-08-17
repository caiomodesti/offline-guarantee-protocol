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
| Reproducible Linux APK build | PENDING | Dedicated `Security Hardening H0 Android` workflow added; remote execution requires push/CI availability |
| Clear-data/reinstall matrix | PENDING | Requires the payer APK plus two ADB-authorized devices |
| Online recovery with active session | **NO-GO — INTEGRATION GAP** | Production UI currently shows a truthful recovery-required screen but has no concrete MWA/RPC/issuer adapter wired behind it |

### Defect found and corrected

The first production bundle attempt failed because Metro did not resolve explicit NodeNext relative `.js` specifiers to their TypeScript sources. The shared build correctly requires the `.js` specifiers, so removing them would break the root NodeNext compilation. A payer-specific Metro resolver now performs only that narrow source mapping and preserves default behavior for packages and real JavaScript files. After the correction, `corepack pnpm check` passed 116 TypeScript tests, six unchanged golden vectors, the Rust cross-language vector test and all 16 program host tests.

This is a mobile build integration correction. It does not alter canonical bytes, signatures, keys, session rules, reconciliation, settlement or economics.

### Windows build limitation

The full local Gradle package also failed in Expo/Nitro CMake configuration because generated Prefab commands live below the physical workspace path containing spaces. A temporary drive alias did not help: pnpm dependency links resolve back to the physical path. The production JS/Hermes bundle passed independently. The reproducible APK path is the Linux GitHub Actions workflow, matching the project's existing Android artifact process.

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
2. Obtain the CI-built production-entrypoint APK.
3. Complete the already-documented Sprint 8 MWA/RPC/certificate-issuer adapter before the active-session online-recovery row can be physically tested. A blocked informational screen is not recovery proof.

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

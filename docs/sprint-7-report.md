# Sprint 7 — QR Mobile MVP Report

Date: 2026-08-13  
Source of truth: original Prompt Master, Sprint 7 only  
Scope boundary: payer + merchant QR communication while offline  
Sprint 8 status: not started

## Outcome

The Sprint 7 implementation is complete at source, host-test, TypeScript, and Metro Android-bundle level. It is not yet fully accepted because this Windows host has no Android SDK, ADB, emulator, or connected test device. A pinned GitHub Actions gate now performs native Android development APK builds for both apps. The final two-device airplane-mode camera test remains mandatory.

Current decision: **CONDITIONAL PASS — NO ADVANCE TO SPRINT 8 until native CI and physical offline scan gates pass.**

## Environment

```text
Windows host
Node                 22.17.0
pnpm                 11.16.0
TypeScript protocol  7.0.2
TypeScript mobile    6.0.3
Expo SDK             57.0.12
React                19.2.3
React Native         0.86.2
expo-camera          57.0.3
expo-secure-store    57.0.1
react-native-quick-crypto 1.1.6
react-native-qrcode-svg   6.3.21
Rust                 1.97.1
Cargo                1.97.1
Android SDK/ADB      unavailable locally
```

Versions are pinned in the workspace lockfile. No silent `latest` dependency is used by the apps.

## Implemented flow

```text
merchant enters amount
  -> creates environment-bound CSPRNG challenge
  -> displays challenge QR
  -> payer scans without network
  -> payer checks environment/self-payment/remaining state
  -> payer persists and signs next canonical state edge
  -> payer displays fragmented portable proof
  -> merchant reassembles and verifies full chain offline
  -> merchant persists claim evidence
  -> merchant displays verified guarantee + pending settlement
  -> merchant returns transport receipt QR
  -> payer verifies acknowledgement of exact credential hash/challenge
```

No app code creates an RPC client or makes a network request in this flow. The development fixture replaces session provisioning only; claim submission and settlement remain Sprint 8.

## QR protocol

`@ogp/transports` implements the Prompt Master's `OfflineTransport` boundary:

- `sendChallenge` / `receiveChallenge`;
- `sendCredential` / `receiveCredential`;
- `sendReceipt` / `receiveReceipt`;
- `QRTransport` as the only implementation.

Frames use the `OGPQR1` prefix, typed messages, complete-payload SHA-256, canonical indices/count, and unpadded base64url chunks. Limits are 64 KiB, 128 frames, and 1,024 maximum configured raw bytes per frame; the default is 480 bytes. Reassembly is order-independent and duplicate-idempotent. Incomplete, mixed, wrong-kind, conflicting, malformed, oversized, and hash-mismatched transfers fail closed.

The merchant challenge intentionally has no payer `session_id`: the merchant does not know it when creating the request. It carries network, cluster genesis, program ID, merchant/device, amount, and random nonce. The payer's signed credential binds those fields to the full session cryptographic domain.

## Offline verification proof

`validateMerchantResponse` does not trust the app screen. It requires:

- expected network, cluster genesis, program ID, and certificate issuer;
- valid wallet `DeviceAuthorization` signature;
- valid issuer `SessionCertificate` signature and matching authorization hash;
- certificate economic/time/depth invariants;
- exact genesis commitment;
- every parent-to-child transition through the complete proof bundle;
- payer device signature on every credential;
- final credential equals final verified state;
- exact outstanding merchant wallet, device, amount, and challenge.

Only after this returns and AsyncStorage persists the evidence does the merchant display:

```text
Session verified
Signature valid
Credential integrity
Guarantee present
Pending settlement
```

The return receipt is explicitly non-economic. It does not prove settlement, coverage, branch order, or an on-chain state change.

## Key custody and crash consistency

- payer session device key: native SecureStore only;
- wallet private key: never held by either Sprint 7 app;
- merchant device key: native SecureStore only;
- payer branch: complete verified bundle persisted before QR display;
- payer restart: restores final tip and resumes unacknowledged delivery;
- merchant challenge: persisted and restored after restart;
- merchant claim: proof frames persisted before UI acceptance;
- public evidence: AsyncStorage, not confidential.

The payer's pre-signed fixture and device seed are development-only bootstrap material. They are not deployment or wallet keys. Sprint 8 must provision a fresh confirmed on-chain session through wallet authorization before devnet acceptance.

## Validation results

```text
protocol TypeScript build       PASS
payer TypeScript                PASS
merchant TypeScript             PASS
Vitest                          41 PASS (5 files)
QR/merchant adversarial tests    7 PASS
golden vectors                   6 PASS
Rust canonical conformance       1 PASS
program Rust tests              16 PASS
cargo fmt                       PASS
git diff --check                PASS
payer Android Metro bundle      PASS — 1,076 modules, ~3 MB Hermes
merchant Android Metro bundle   PASS — 1,076 modules, ~3 MB Hermes
```

The QR tests cover challenge and portable-bundle round trips, fragmentation, reverse order, identical duplicate frames, missing frames, mixed transfers, wrong message kind, content tampering, receipt binding, zero amount/challenge, and merchant acceptance under wrong merchant, amount, challenge, issuer, and program ID.

## Native Android gate

`.github/workflows/sprint-7-mobile-android.yml` runs a payer/merchant matrix on Ubuntu 24.04 with Node 22.17.0, pnpm 11.16.0, Temurin Java 17, Expo prebuild, and Gradle `assembleDebug`. It uploads one development APK per app. Result is pending until this branch is pushed.

## Hostile audit

### Findings fixed

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Practical after payer restart | One monotonic local branch | Initial UI kept parent only in React state | Persist verified full bundle before display; restore tip and pending delivery | FIXED |
| High | Practical UI forgery | Merchant acceptance | Screen could have inferred guarantee from decoded fields | Shared production verifier plus evidence persistence before acceptance | FIXED |
| High | Practical message substitution | Merchant/amount/challenge binding | Transport alone authenticates bytes, not business expectation | Exact outstanding request comparison after full cryptographic validation | FIXED |
| Medium | App restart | Challenge single-use/liveness | Outstanding challenge initially existed only in memory | Persist device-bound challenge and restore QR | FIXED |
| Medium | Large valid branch | QR liveness | Complete proof exceeds one QR after early depth | Deterministic fragmentation with animated display and 64 KiB cap | FIXED |
| Medium | Camera repeats/reorders frames | Transfer integrity | Scanner callbacks are not ordered or exactly once | Set assembly, identical duplicate idempotency, full hash | FIXED |
| Medium | Mixed people/old screen | Cross-transfer confusion | Valid frames from different transfers can interleave | One hash/count identity per assembly; mixed transfer rejection | FIXED |

### Remaining risks

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High for any real use | Source extraction | Payer signing authority | Development device seed is compiled into fixture app | Replace with Sprint 8 freshly generated/provisioned session key; forbid fixture in devnet/release config | OPEN GATE |
| High | Device compromise | Offline branch integrity | Software device keys remain extractable on rooted/compromised devices | Session/time/branch/cap scope; hardware-backed signing deferred | OPEN RISK |
| Medium | Camera/device variance | Offline transport liveness | No physical scan performed on this host | Two Android devices, airplane mode, low light, dropped frames, restart matrix | OPEN GATE |
| Medium | Native dependency incompatibility | App availability | Local host lacks Android toolchain | Remote Gradle matrix build | PENDING CI |
| Medium | Local storage loss | Merchant evidence availability | AsyncStorage is not durable backup | Submit promptly after reconnect in Sprint 8; export/redundancy later | OPEN RISK |
| Medium | Metadata disclosure | Privacy | Full prior branch and claims stored/displayed locally | Documented non-private MVP; selective disclosure deferred | OPEN RISK |
| Low | Receipt spoofing | UX acknowledgement only | Receipt is unsigned | Never treat as economic proof; signature remains deferred | ACCEPTED MVP LIMITATION |
| Low | QR denial of service | Availability | Attacker can flood malformed frames | Strict bounds/fail-closed/reset; no economic state change | ACCEPTED MVP RISK |

## Acceptance matrix

| Gate | Result |
|---|---|
| Payer + merchant source implementation | PASS |
| Offline verifier uses portable cryptographic chain | PASS |
| Fragmented QR transport and adversarial host tests | PASS |
| Restart-safe payer branch | PASS by implementation/typecheck; physical kill test pending |
| Evidence persisted before merchant acceptance | PASS by implementation/typecheck; physical kill test pending |
| Android Metro bundles | PASS |
| Native Android APK compile | PENDING REMOTE CI |
| Two-device airplane-mode QR exchange | NOT RUN |
| Physical SecureStore/restart/camera matrix | NOT RUN |

## Decision

`CONDITIONAL PASS — IMPLEMENTATION COMPLETE, DEVICE ACCEPTANCE OPEN.`

Sprint 8 must not start until the native Android workflow passes and a complete payer → merchant → payer exchange succeeds between two devices with both devices in airplane mode. This is an execution gate, not a chronology or architecture change.

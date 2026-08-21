# ADR-0021 — Device-key feasibility boundary

- Status: Accepted; H2 physical capability matrix complete
- Date: 2026-08-18
- Scope: security-hardening H2 only

## Context

OGP v0.1 signs offline credentials with Ed25519. The payer and merchant generate software Ed25519 seeds and store them through Expo SecureStore. H0 and H1 established fail-closed lifecycle and crash consistency, but neither proves that the protocol signing key is non-exportable or StrongBox-backed.

H2 is authorized to measure Android Keystore, StrongBox and attestation feasibility. It is not authorized to change the production signer, canonical schemas, domain separation, golden vectors, protocol economics or attestation protocol.

## Current implementation — measured source facts

The locked mobile dependency is `expo-secure-store@57.0.1`. Its Android `AESEncryptor.kt` has SHA-256 `D3A86DE25C64935E84B6999101556B0E9F8BC6C90CE7600C421125B3E18AA3F4`, and its package manifest has SHA-256 `B0E229328F8389175825CD43DFDFE2AAE482D9DCE6DBCA6BEE480FDCDB7B81EC`.

The inspected implementation:

- generates an AES-256-GCM wrapping key in `AndroidKeyStore`;
- sets `setUserAuthenticationRequired(options.requireAuthentication)`;
- defaults `requireAuthentication` to `false`;
- exposes no option that requests StrongBox, sets an attestation challenge or reports `KeyInfo.getSecurityLevel()`;
- encrypts the stored value at rest, then returns its plaintext to JavaScript when read.

The payer and merchant pass `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, but Android's `SecureStoreOptions` contains only `authenticationPrompt`, `keychainService` and `requireAuthentication`. The accessibility constant is an iOS keychain control; it does not make the Android signer non-exportable. Neither production app currently sets `requireAuthentication`.

Therefore the accurate statement for v0.1 is:

> SecureStore protects the software Ed25519 seed at rest with an Android Keystore AES wrapper. Equivalent AES specifications reached TEE on both target devices, but the already-created SecureStore aliases were not directly introspected. The Ed25519 seed remains exportable to the application process during signing.

It is incorrect to call the current OGP signing identity hardware-backed, StrongBox-backed or non-exportable.

## Options considered

| Option | Protocol/schema effect | Security value | Limits | H2 disposition |
|---|---|---|---|---|
| A. Current SecureStore-wrapped Ed25519 seed | None | Android Keystore protects the seed at rest; preserves portable Ed25519 and all v0.1 vectors | Seed is returned to JS; no StrongBox request, OGP-key attestation or non-exportability | **DECIDED FOR MVP — retain without overstating guarantees** |
| A+. SecureStore with `requireAuthentication` | None to signed objects | Adds user-presence gating around wrapper-key use on supported devices | Still returns the Ed25519 seed to JS; authentication changes can invalidate data; UX and recovery policy need separate testing | **DEFERRED** |
| B. Native AES wrapper explicitly measured/requested as TEE or StrongBox | No signed-schema change if it only wraps the same Ed25519 seed | Makes the at-rest property observable and can prefer stronger hardware | Seed still reaches the app process; StrongBox is optional, slower and resource-constrained; needs native integration not authorized in H2 | **DEFERRED** |
| C. Non-exportable P-256 Android Keystore/StrongBox protocol signer with verified attestation | Changes signature algorithm, public-key representation, canonical objects, verifiers and likely on-chain paths | Best supported Android route to hardware-bound signing and attestable key properties | Platform-specific trust, off-device attestation verification, revocation, privacy, compatibility and migration complexity | **DEFERRED — requires a new ADR and explicit approval** |
| D. Non-exportable Ed25519 Android Keystore signer | Would preserve the algorithm if uniformly available, but changes key lifecycle and verification inputs | Could avoid exposing the private key to JS | Android's documented StrongBox subset does not guarantee Ed25519; provider support and attestation portability are device-dependent | **OPEN RISK — measure only** |
| E. External wallet signature for every offline payment | Changes the interaction and authority boundary | Can delegate custody to wallet hardware/software | Cannot be assumed available while both parties are offline and is not a substitute for the session device signer | **REJECTED FOR MVP FLOW** |

## Capability probe

H2 adds a standalone package, `protocol.ogp.h2probe`, which is not linked from either production application. It creates only ephemeral aliases and deletes them after each measurement. It attempts:

- AES-256-GCM in default Android Keystore and requested StrongBox;
- P-256 ECDSA with an attestation challenge in default Android Keystore and requested StrongBox;
- experimental Ed25519 in default Android Keystore and requested StrongBox.

For generated private/secret keys it records support, actual `KeyInfo` security level, round-trip/signature success and whether `getEncoded()` is null. For P-256 it records only attestation-chain length and presence of the Android attestation extension. It does not emit raw private keys, public keys, certificates, attestation records, device serials or Android IDs. The host collector accepts only one base64-framed JSON result bound to the requested device label, rejects fatal or incomplete output and hashes the stored evidence.

The probe APK is non-debuggable, disables backup and declares no permissions, including no Internet permission. Device A used build `20260821T013305Z`, SHA-256 `C8F31F332E044EC910DF41E25A6EF174888B19F4059265EA08911B70FBE3AAA7`; Device B used build `20260821T014422Z`, SHA-256 `5100D51A2FA4B5CDEDE99E767F54A71ED6C5AFBE3D7AEC2E4DC723ADB939EB76`. Both APKs are 16,787 bytes and APK Signature Schemes v1, v2 and v3 verify. The signing keys are ephemeral and make these research artifacts, not distributable applications.

Physical results are intentionally not inferred from source or H0 logs. Device A (Samsung SM-G781B, Android 13 / API 33) produced a complete label-bound result with SHA-256 `6F33027D9C204EF117161BD9ABD85BC290395F545EAF99D68126D0CF6CD0B58A`. Its equivalent default AES-256-GCM key was non-exportable in the trusted environment; requested StrongBox AES and P-256 keys were also non-exportable and reported `STRONGBOX`. AndroidKeyStore rejected Ed25519 with `NoSuchAlgorithmException`.

Device B (Samsung SM-A236M, Android 14 / API 34) produced a complete label-bound result with SHA-256 `5B1A4F6102D6ED9F99745E0697ADACD92D6432823BB5FDEFC033F1A9DB8A46A0`. Default AES-256-GCM and P-256 were non-exportable in the trusted environment, but the device does not advertise StrongBox. AndroidKeyStore also rejected Ed25519. On both devices, default P-256 signed and verified, returned a four-certificate chain and exposed the Android attestation extension. These results measure platform capability, not the private properties of already-created SecureStore aliases.

## Attestation boundary

An on-device report that an attestation extension exists is only a capability signal. Trustworthy production attestation requires off-device validation of the certificate chain, trusted root, challenge, attestation security level and current revocation status. Verification on the same potentially compromised device is not a security proof.

No attestation bytes enter an OGP object in H2. No server trust root, enrollment policy, device allowlist or revocation policy is created.

## Decision

1. Keep the v0.1 Ed25519 production signer and all existing canonical/signed objects unchanged.
2. Describe the present design as a software Ed25519 seed protected at rest by a Keystore AES wrapper, not as a non-exportable signer.
3. The two-device capability matrix is complete. It proves TEE availability on both devices, StrongBox fragmentation and lack of AndroidKeyStore Ed25519 on both tested providers. H2 passes and authorizes H3 without changing production cryptography.
4. Do not silently fall back from requested StrongBox while claiming StrongBox protection. Any future policy must record the actual security level.
5. Treat a P-256/non-exportable signer or any protocol attestation as a versioned architectural change requiring a separate ADR, migration/compatibility design and explicit approval.
6. Hardware backing does not solve full-device state rollback, offline monotonicity or economic double spending. Existing cap, fork detection and deterministic reconciliation remain necessary.

## References

- [Android Keystore system](https://developer.android.com/privacy-and-security/keystore)
- [Android `KeyInfo`](https://developer.android.com/reference/android/security/keystore/KeyInfo.html)
- [Android key attestation](https://developer.android.com/privacy-and-security/security-key-attestation)
- [Expo SecureStore](https://docs.expo.dev/versions/v55.0.0/sdk/securestore/)

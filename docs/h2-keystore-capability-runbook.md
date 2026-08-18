# H2 Android Keystore capability runbook

This runbook measures platform capabilities only. It does not change the OGP signer, sign a protocol object or grant economic authority.

## Safety properties

- standalone package: `protocol.ogp.h2probe`;
- no Android permissions, including no Internet permission;
- backup disabled and release manifest non-debuggable;
- explicit ADB serial required and emulators rejected;
- signature, exact package, zero-permission manifest, backup/debug policy and build SHA-256 are reverified immediately before installation;
- evidence directory uses an operator label, never the device serial;
- no raw key, certificate, attestation record or unique device identifier is emitted;
- captured output is base64-framed, decoded as strict JSON, bound to the requested device label, rejected on fatal/incomplete output and stored with a SHA-256 sidecar;
- all measurement aliases are ephemeral and deleted after use.

## Build

Prerequisites are JDK 17 and Android SDK platform/build-tools 36. The script pins those paths and fails if any tool is missing.

```powershell
.\scripts\h2-android-keystore-probe.ps1 -Action Build
.\scripts\h2-android-keystore-probe.ps1 -Action Verify
```

Expected verified artifact:

```text
artifacts/security-hardening/h2/keystore-probe/<UTC>/ogp-h2-keystore-probe.apk
artifacts/security-hardening/h2/keystore-probe/<UTC>/ogp-h2-keystore-probe.apk.sha256
```

## Physical measurement

List authorized devices, choose one explicit physical serial, and use only the non-identifying labels `device-a` and `device-b` in evidence:

```powershell
& "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" devices -l
.\scripts\h2-android-keystore-probe.ps1 -Action Install -Serial '<explicit-serial>' -DeviceLabel 'device-a'
.\scripts\h2-android-keystore-probe.ps1 -Action Run -Serial '<explicit-serial>' -DeviceLabel 'device-a'
.\scripts\h2-android-keystore-probe.ps1 -Action Capture -Serial '<explicit-serial>' -DeviceLabel 'device-a'
```

Repeat for `device-b`. `-Action All` may be used to build, install, run and capture in one invocation.

## Acceptance interpretation

For each device, record separately:

- `strongbox_feature`;
- AES default support and actual security level;
- AES requested-StrongBox support and actual security level;
- P-256 sign/verify, actual security level, chain length and attestation-extension presence;
- P-256 requested-StrongBox equivalent;
- experimental Ed25519 provider result for default and requested StrongBox.

`supported=false` is a valid measurement, not a harness failure. A fatal probe error, missing output or contradictory security-level result is a harness failure and must be investigated.

Do not interpret extension presence or chain length as trusted attestation. Production attestation would require off-device chain, challenge, security-level and revocation validation.

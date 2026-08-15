# ADR-0018: Sprint 7 offline QR mobile flow

- Status: Accepted for MVP
- Date: 2026-08-13

## Context

The Prompt Master fixes Sprint 7 as the payer/merchant QR mobile MVP and requires communication to work offline. Sprint 8, not Sprint 7, owns on-chain activation, reconnect, claim submission, and settlement E2E. A complete portable proof can grow from 1,402 bytes at the first payment to more than 16 KiB at maximum branch depth, so a single static QR is not a valid transport design.

The merchant creates its challenge before learning the payer session. Requiring a session ID in that first message would add pre-pairing or network coordination that the specified merchant flow does not have.

## Decisions

### Offline exchange

The MVP exchange is:

1. merchant creates a 32-byte CSPRNG challenge bound to configured network, cluster genesis, program ID, merchant, merchant device, and amount;
2. payer checks the configured environment, available branch state, and self-merchant rule;
3. payer signs a canonical `PaymentCredential` that binds the challenge, merchant fields, amount, exact session domain, parent, and resulting state;
4. payer sends the complete `DeviceAuthorization + SessionCertificate + credential chain` proof bundle;
5. merchant validates the trust root, domain, authorization/certificate chain, every reachable transition, signature, final tip, merchant fields, amount, and outstanding challenge;
6. merchant durably stores evidence before showing acceptance;
7. merchant may return a transport receipt bound to credential hash and challenge.

No step makes an RPC request. Offline `created_at` remains metadata and is not used to order branches.

### Why the initial challenge has no session ID

The challenge is neither signed evidence nor an economic claim. It is a fresh request nonce and display payload created before the merchant knows the payer session. Network, cluster genesis, and program ID prevent accidental environment mismatch. The payer's signed credential supplies the exact session-bound cryptographic domain and commits to every challenge field that matters economically.

### QR framing

`QRTransport` uses deterministic `OGPQR1` frames with:

- message kind;
- SHA-256 of the complete payload;
- canonical zero-based frame index and total count;
- unpadded canonical base64url chunk.

The implementation accepts out-of-order frames and identical duplicates. It rejects missing frames, mixed transfers, conflicting duplicates, wrong message kinds, non-canonical encoding, hash mismatch, payloads above 64 KiB, and more than 128 frames. Default raw chunk size is 480 bytes. Animated QR display rotates every 650 ms.

### Local durability and key custody

- payer per-session device secret is read from SecureStore/Keychain/Keystore and never stored in AsyncStorage;
- payer persists the new complete bundle before displaying it, preventing restart from silently returning to genesis;
- an unacknowledged outgoing credential resumes after restart;
- merchant device secret uses SecureStore;
- outstanding merchant challenge resumes after restart;
- merchant evidence is persisted before the UI displays `Guarantee present`;
- public proof bytes and pending-claim metadata use AsyncStorage and are therefore not confidential.

The Sprint 7 payer contains an explicitly development-only pre-signed session fixture and per-session device seed. It is not a wallet seed or deployment key. Sprint 8 must replace fixture provisioning with the confirmed on-chain session lifecycle and MWA wallet authorization before any devnet claim.

### Receipt semantics

The QR receipt proves only that the merchant app acknowledged the exact credential hash and challenge. It is unsigned and has no coverage, settlement, ordering, or on-chain authority. Merchant receipt signatures remain deferred.

The merchant history distinguishes only locally observable facts: proof verified and stored, receipt not shown/shown/unknown for legacy records, and settlement pending. Showing a receipt does not prove that the payer scanned it. Adding a third payer-to-merchant acknowledgement would change the transport flow and is not part of Sprint 7.

Stored proof bundles are revalidated from their canonical QR frames before the history calls them verified. Metadata in AsyncStorage is not trusted by itself. All edges in every complete stored bundle may then be compared to produce a **possible local conflict** warning under the formal sibling predicate: same session, parent state hash, and sequence with different resulting state hashes. This warning is provisional. It MUST NOT use the protocol headline `FORK DETECTED`, revoke access, change coverage, or imply on-chain confirmation before Sprint 8/9 submits and verifies the evidence through the program.

Portuguese is the primary MVP interface language for the current owner/device testing. English localization is presentation work and does not change signed protocol bytes, schemas, status enums, or the immutable sprint chronology.

## Rejected alternatives

- Single static QR: fails as branch proof size grows.
- JSON evidence: introduces ambiguity and duplicates canonical protocol schemas.
- Challenge bound to payer session: merchant does not know the session at challenge creation.
- Trusting a local `Guarantee present` flag: cannot prove certificate chain or credential reachability.
- Sending only the last credential: merchant cannot prove its parent is reachable from genesis.
- Storing the payer device key in AsyncStorage: exposes signing authority in unencrypted app storage.

## Consequences

- QR is replaceable behind `OfflineTransport`; Bluetooth remains Sprint 11.
- Later merchants see the prior branch proof in MVP, preserving the documented privacy risk.
- Frame loss is a liveness failure, never partial acceptance.
- A compromised payer app can still fork; the protocol detects and economically contains rather than preventing it.
- Native build and a two-device network-disabled camera proof are required before Sprint 7 is marked fully accepted; both passed. The broader restart matrix remains non-blocking hardening governed by Sprint 8 fail-closed recovery.

# Sprint 1 — portable cryptographic core

Status: **COMPLETE FOR DEFINED SCOPE; Sprint 2 NOT STARTED**

## Outcome

Sprint 1 turns the Sprint 0 cryptographic specification into a runnable, deterministic portable core. TypeScript is the reference implementation used by clients; Rust is an independent conformance implementation for the exact Borsh bytes, SHA-256 hashes, and strict Ed25519 verification.

Implemented:

- frozen primitive types, object tags, domain header, and checked integer guards;
- canonical encoders for `DeviceAuthorization`, `SessionCertificate`, `GenesisState`, `PaymentState`, `PaymentCredential`, `IdentityAttestation`, and `CredentialProofBundle`;
- exact-length decoders for the three portable signed wrappers used in the claim path;
- SHA-256, RFC 8032-compatible Ed25519 signing and strict verification, OS-CSPRNG keys/challenges, and all-zero challenge rejection;
- wallet authorization → trusted certificate issuer → genesis → complete credential branch validation;
- deterministic state transitions and reachability validation up to depth 32;
- formal sibling fork detection that excludes invalid credentials and deduplicates identical child hashes;
- six public golden vectors with no private key material;
- independent Rust Borsh round-trip, SHA-256, and strict Ed25519 verification.

Not implemented, by scope:

- Solana/Anchor program, PDAs, SPL custody, Ed25519 instruction introspection, claim accounts, finalization, allocation, settlement, and withdrawal;
- mobile key storage, QR framing/chunking, offline clocks, dashboard, or demo event projection;
- schemas for reserved future object tags `MerchantReceipt`, `ClaimCommitment`, `ForkWitness`, and `ResolutionPlan`.

## Frozen implementation choices

| Concern | TypeScript | Independent Rust harness |
|---|---|---|
| Language/toolchain | Node >=22.17, TypeScript 7.0.2 | Rust 1.97.1, edition 2024 |
| Canonical encoding | `borsh` 2.0.0 | `borsh` 1.8.0 |
| Ed25519 | `@noble/ed25519` 3.1.0 with `zip215: false` verification | `ed25519-dalek` 3.0.0 `verify_strict` |
| Hash | `@noble/hashes` 2.3.0 SHA-256/SHA-512 | `sha2` 0.11.0 |
| Property tests | Vitest 4.1.10 + fast-check 4.9.0 | Rust unit test against the same fixture |
| Dependency freeze | `pnpm-lock.yaml` | crate-local `Cargo.lock` |

The trusted certificate issuer is configuration, not a key learned from the certificate. All security-boundary verification APIs require a `ProtocolTrustContext` containing network, genesis hash, program ID, session ID, and the trusted issuer public key.

## Canonical sizes

| Object | Signed/hashed payload | Wrapper including signature |
|---|---:|---:|
| Domain header | 110 bytes | — |
| Device authorization | 306 bytes | 370 bytes |
| Session certificate | 490 bytes | 554 bytes |
| Genesis state | 210 bytes | — |
| Payment state | 234 bytes | — |
| Payment credential | 410 bytes | 474 bytes |
| Identity attestation | 224 bytes | 288 bytes |

The canonical proof bundle is:

```text
554-byte certificate
+ 370-byte device authorization
+ 4-byte Borsh vector length
+ depth * 474-byte credentials
```

Therefore a one-payment bundle is 1,402 bytes and the maximum depth-32 bundle is exactly 16,096 bytes. The maximum is deterministic and tested. It is too large for a comfortable single QR code and makes chunked/framed transport a Sprint 2 design requirement, not an assumption hidden in the cryptographic layer.

## Verification evidence

The TypeScript suite contains 14 adversarial/property tests covering:

- exact canonical lengths and strict round trips;
- truncation and trailing-byte rejection;
- every one-byte mutation across the 410-byte credential payload invalidating the original signature;
- replay-domain changes for network, genesis hash, program ID, version, object type, and session;
- non-zero CSPRNG challenges;
- trusted issuer enforcement;
- certificate-chain, genesis, and full reachability verification;
- 64 randomized admissible monetary transitions;
- signature, arithmetic, and resulting-state-hash mutations;
- normal branch, identical replay, simple fork, triple fork, and invalid-credential branch;
- an actual 32-edge proof bundle plus rejection of edge 33.

The Rust test consumes the same six published vectors, strictly decodes and re-encodes each Borsh structure, recalculates every SHA-256 value, and verifies every signature with strict Ed25519 rules. Clippy passes with warnings treated as errors. The production npm dependency audit reports no known vulnerabilities at completion time.

## Hostile self-audit

### Finding fixed: embedded issuer was not a trust root

The first implementation verified `SessionCertificate` against the issuer key carried inside that certificate. That proves self-consistency but would accept an attacker-created issuer. This was classified **CRITICAL** and fixed before closure: `ProtocolTrustContext.trustedCertificateIssuer` is mandatory and must equal the certificate issuer before any credential or fork can be authenticated. A regression test uses a cryptographically valid certificate under an untrusted configuration and requires rejection.

### Finding fixed: context checks were incomplete

Signature verification alone did not initially compare every configured domain field before using a certificate. Verification now binds the full network ID, cluster genesis hash, program ID, object type, protocol/schema versions, and session. Mutations are rejected before economic interpretation.

### Finding fixed: wallet/device key separation needed enforcement

The specification requires a per-session device key different from the wallet key. Certificate-chain validation now rejects equality even if both signatures are otherwise valid.

### Finding fixed: maximum transport size was implicit

The full branch prefix is now canonically encoded and tested at depth 32. Its 16,096-byte maximum is explicit, exposing the QR transport constraint early.

### Remaining open risks

| Risk | Severity now | Why Sprint 1 cannot close it | Required future gate |
|---|---|---|---|
| Compromised software device key can sign many branches | Critical protocol premise, economically bounded only after on-chain implementation | Portable crypto cannot enforce custody/cap | On-chain cap/reserve invariants plus mobile secure-storage threat tests |
| TypeScript cryptography is not guaranteed constant-time under JIT/GC | Medium | Runtime limitation | Keep secret-key operations minimal; assess native/platform signer before production |
| React Native may lack a correct `getRandomValues` provider | High until mobile integration | No mobile runtime exists yet | Fail-closed platform CSPRNG integration and device tests |
| Issuer rotation/revocation and offline freshness are not implemented | High | Requires authoritative state/distribution design | Versioned trust bundle and revocation/freshness ADR before production |
| On-chain Ed25519 instruction parser is absent | Critical for claims, intentionally Sprint 2+ | No Solana program exists | Adversarial instruction-offset/substitution suite before accepting claims |
| A 16 KB branch proof needs chunking and durable assembly | Medium for hackathon UX | Transport is outside cryptographic core | Authenticated framing, completeness, reordering, duplication, and corruption tests |
| Reserved object tags 6–9 have no frozen schemas | Low for current scope, high if used prematurely | Their on-chain structures are not implemented | Reject their use until a schema ADR and cross-language vectors exist |

## Stop condition

Sprint 1 is complete only for the portable cryptographic and credential layer described above. No Sprint 2 artifact has been created. The next review should decide whether the 16 KB transport ceiling and explicit issuer trust model are acceptable before an Anchor program is scaffolded.


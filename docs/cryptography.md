# Cryptography and canonical encoding

Status: **DECIDED FOR MVP and implemented for the Sprint 1 portable core**

## Primitive choices

| Purpose | MVP choice | Reason | Principal risk |
|---|---|---|---|
| Digital signatures | Ed25519 | Native Solana account keys and verification support; mature mobile/JS/Rust libraries | Key extraction or misuse, signature-instruction parsing bugs |
| Hashing | SHA-256 | Available in Solana, Rust, Web Crypto-compatible environments, and audited libraries | Domain/encoding mistakes, not primitive weakness |
| Random challenge/nonces | 32 bytes from OS CSPRNG | 256-bit space and broad mobile support | Broken platform RNG or nonce reuse |
| Encoding | Canonical Borsh with frozen v1 schemas | Natural in Solana, deterministic across Rust/TypeScript, no JSON ambiguity | Schema drift or permissive decoders |

No custom cipher, signature scheme, hash construction, or random generator is permitted. Sprint 1 pins `borsh` 2.0.0, `@noble/ed25519` 3.1.0, and `@noble/hashes` 2.3.0 in TypeScript; the independent harness pins `borsh` 1.8.0, `ed25519-dalek` 3.0.0, and `sha2` 0.11.0 in Rust. Lockfiles freeze transitive dependencies.

## Canonical encoding rules

1. Signed/hashed structures use canonical Borsh and fields appear exactly in the normative schema order.
2. Unsigned integers use fixed-width little-endian bytes.
3. Signed timestamps use two's-complement fixed-width `i64` little-endian.
4. Public keys, hashes, challenges, and signatures have fixed lengths; no length prefix.
5. Booleans are one byte, `0x00` or `0x01` only.
6. Enums are one `u8` with unknown values rejected.
7. Strings, maps, floats, optional fields, implicit defaults, and unordered collections are forbidden in MVP signed payloads.
8. A decoder MUST reject truncation, trailing bytes, non-canonical enum/boolean values, overflow, and length mismatch.
9. Signatures are not included in the bytes they sign. An object's hash includes the signed payload, not an arbitrary serialized wrapper.
10. New fields require a new object schema/version; decoders never guess.

## Cryptographic domain

Every hashed or signed payload begins with this fixed domain header:

```text
protocol_name:           [u8; 8]  = ASCII "OGP\0\0\0\0\0"
protocol_version:        u16      = 1
schema_version:          u16      = object schema version, initially 1
object_type:             u8       = registered tag
network_id:              u8       = 0 localnet, 1 devnet, 2 mainnet-beta
cluster_genesis_hash:    [u8; 32]  = decoded Solana genesis hash
program_id:              [u8; 32]
session_id:              [u8; 32]  = zero only for protocol-global objects
```

Object tags:

```text
1 DeviceAuthorization
2 SessionCertificate
3 GenesisState
4 PaymentState
5 PaymentCredential
6 MerchantReceipt
7 ClaimCommitment
8 ForkWitness
9 ResolutionPlan
10 IdentityAttestation
```

This header prevents a valid payload from being interpreted across localnet, devnet, mainnet-beta, a custom cluster with a different genesis hash, another program ID, protocol/schema version, object type, or session. Human-readable cluster names alone are insufficient; the genesis hash is required.

## Hash and signature constructions

Notation:

```text
ENCODE(T, fields) = exact canonical bytes for object type T
HASH(T, fields)   = SHA256(ENCODE(T, fields))
SIGN(sk, T, fields) = Ed25519.Sign(sk, ENCODE(T, fields))
```

There is no ambiguous `HASH(prefix || json)` construction. Conceptually, the signed material is `Borsh(DomainSeparator) || Borsh(CanonicalPayload)`; both structures have frozen field order and exact sizes.

### Genesis state

```text
GenesisState payload after domain:
  owner
  device_public_key
  branch_spending_limit
  max_branch_depth
  initial_remaining
  issued_at
  expires_at
```

`initial_remaining` MUST equal `branch_spending_limit`.

### Payment state

```text
PaymentState payload after domain:
  previous_state_hash
  sequence
  merchant
  amount
  merchant_challenge
  previous_remaining
  new_remaining
```

`new_state_hash = HASH(PaymentState, fields)`.

### Credentials

The payer device signature covers the complete `PaymentCredential` payload excluding `payer_signature`, including both state hashes, both remaining values, merchant, merchant device key, challenge, metadata timestamp, and session expiry.

The certificate issuer signature covers the complete `SessionCertificate` payload excluding `issuer_signature`. The wallet signature similarly covers all `DeviceAuthorization` fields excluding `wallet_signature`.

## Key formats and separation

- Wallet, device, merchant, and issuer public keys are raw 32-byte Ed25519 keys.
- Signatures are raw 64-byte Ed25519 signatures.
- A device key MUST be generated per session and MUST NOT equal the wallet key.
- Wallet software MUST display the session, device key, expiry, branch limit, and coverage cap before authorization.
- Device private keys never enter QR payloads, logs, fixtures, or repository files.
- Hardware-backed storage is **DEFERRED**. Platform secure storage is preferred but is not treated as a hardware guarantee.
- Android may later use TEE/Secure Element keys plus attestation. iOS Secure Enclave natively centers on P-256 rather than portable Ed25519 signing, so the MVP makes no cross-platform hardware guarantee and uses a portable software Ed25519 device key.
- Issuer, admin, emergency, and upgrade authorities are logically separate keys.

## Merchant challenge and replay controls

The merchant generates 32 bytes using the operating system CSPRNG for every interaction. All-zero challenges are invalid. The challenge, merchant settlement authority, session, sequence, amount, and parent hash are device-signed.

Replay layers:

1. exact credential hash is the claim PDA/idempotency key;
2. the economic state-edge key `(session, parent_hash, sequence, child_hash)` prevents distinct signed wrappers for the same payment state from receiving two allocations;
3. domain/session binding prevents cross-environment and cross-session replay;
4. merchant binding prevents another merchant from redeeming it;
5. transition parent/sequence controls graph placement;
6. claim deadline prevents indefinitely late first submission.

`credential_hash` uniqueness alone is insufficient for economic idempotency because authenticated metadata excluded from `PaymentState` (for example `created_at`) can change the credential bytes without changing the economic state edge. Sprint 2 therefore distinguishes `DUPLICATE_CREDENTIAL` from `DUPLICATE_STATE_EDGE`.

A reused challenge is detectable in merchant local history but does not by itself prove payer fraud. Global challenge-uniqueness enforcement is **DEFERRED** because it could introduce arrival-dependent classification.

## Offline time limitation

`created_at` is authenticated metadata, not a trusted timestamp. It can help users audit history and can be checked for internal range consistency, but it MUST NOT:

- prove real-world creation time;
- decide which branch is canonical;
- prioritize settlement;
- defeat an otherwise valid fork;
- replace the on-chain claim submission deadline.

Secure time hardware, third-party timestamping, and merchant receipt co-signatures are **DEFERRED**. Backdating by a compromised payer is an **OPEN RISK**.

## On-chain verification contract

The MVP design uses Solana's standard Ed25519 verification instruction plus instruction-sysvar introspection. A protocol instruction MUST verify that the expected prior verification instruction covers the exact canonical bytes, public key, and signature associated with the current claim or parent-key fork-record update. It MUST reject index confusion, offset overlap, substituted message bytes, duplicate unchecked instructions, or a verifier belonging to the wrong program.

The exact parser and transaction layout require adversarial tests before implementation is accepted. Treating a client boolean such as `signatureValid: true` as evidence is forbidden.

## Required Sprint 1 test vectors

- identical fields produce identical bytes in Rust and TypeScript;
- every one-byte mutation changes the hash and invalidates the original signature;
- reordered or omitted fields fail decoding/verification;
- localnet bytes fail under devnet/mainnet domains;
- changed genesis hash, program ID, protocol version, schema version, object tag, or session ID fails;
- wrong wallet/device/issuer/merchant keys fail;
- trailing bytes and unknown enum tags fail;
- maximum integer values fail safely on invalid arithmetic;
- deterministic published hex fixtures cover every signed/hashed object.

## Decision status

| Topic | Status |
|---|---|
| Ed25519, SHA-256, 32-byte CSPRNG challenges | DECIDED FOR MVP |
| Canonical Borsh schemas and full domain header | DECIDED FOR MVP |
| Per-session device key | DECIDED FOR MVP |
| Exact implementation libraries and versions | DECIDED FOR MVP; pinned in both lockfiles |
| Hardware-backed keys and secure time | DEFERRED |
| Compromised software device key/backdated metadata | OPEN RISK |
| SHA-256/Ed25519 cryptanalytic break | OPEN RISK, accepted as infeasible for MVP |

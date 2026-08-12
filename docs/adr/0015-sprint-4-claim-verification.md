# ADR-0015: Sprint 4 claim verification and economic-edge indexing

- Status: Accepted for MVP
- Date: 2026-08-12

## Context

Claim collection must not trust a relayer's assertion that a credential was checked. It must also prevent both exact credential replay and economically equivalent signed wrappers from multiplying exposure. Replaying an entire portable certificate inside every claim transaction would repeat facts already held in the authoritative session account and consume transaction space without adding economic authority.

## Decision

`submit_claim` receives the exact canonical 410-byte `PaymentCredential` payload and its 64-byte device signature. The immediately preceding native Ed25519 instruction must reference the public key, message, and signature inside that same Anchor instruction. The program accepts exactly one signature descriptor and exact instruction indexes, offsets, lengths, program IDs, and bytes; embedded or substituted messages are rejected.

After native signature verification, the program independently parses and checks:

- protocol/schema/object/network/genesis/program/session domain;
- authoritative payer, device, merchant, session expiry, claim deadline, and session status;
- nonzero challenge, amount, remaining-value arithmetic, depth, parent reachability, and recomputed payment-state hash;
- one-shot registered portable authorization hash.

The certificate issuer signature remains required for offline merchant acceptance. It is not replayed on-chain per claim because the program reads the stronger authoritative session facts directly and the issuer has no economic authority. The relayer cannot change the settlement merchant.

Every unique wrapper maps to `Claim[session, credential_hash]`. Every economic transition maps to `StateEdgeRecord[session, parent_hash, sequence, child_hash]`. A new edge increments session exposure and edge count once. A second valid wrapper for the same edge creates a diagnostic rejected claim, increments only `wrapper_count`, and updates the lexicographically smallest representative hash. Exact replay fails with `DuplicateCredential`.

Claim and edge accounts plus `ClaimSubmitted` events form the rebuildable MVP index. Because these accounts are initialized manually to support idempotent edge insertion, the Anchor IDL does not discover their layouts automatically. `@ogp/protocol-sdk` is therefore the canonical strict decoder: it verifies the exact account size and discriminator before decoding the fixed Sprint 4 byte layout. Indexers must also verify the account owner against the configured program ID. Full evidence remains with merchants. No fork classification, allocation, settlement, collateral release, or revocation occurs in Sprint 4.

## Consequences

- Claim correctness does not depend on a trusted backend or client boolean.
- The transaction layout is intentionally strict and schema-version-specific.
- Session writes serialize concurrent submissions; account/rent spam remains an open scalability risk.
- Indexers can be deleted and rebuilt from program accounts/events but cannot reconstruct full credentials if merchants lose them.
- A future schema must define new offsets/version handling rather than weakening this parser.

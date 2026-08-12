# ADR-0002: Canonical encoding and cryptographic domain

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

JSON and partial context binding permit ambiguous encodings and replay between deployments.

## Decision

Use canonical Borsh with strict frozen v1 schemas, SHA-256 hashes, and Ed25519 signatures. Every payload begins with protocol name, protocol version, schema version, object tag, network ID, cluster genesis hash, program ID, and session ID. Decoders reject trailing or non-canonical bytes.

## Consequences

- Localnet/devnet/mainnet, program, version, type, and session replay are separated.
- Cross-language golden vectors become mandatory.
- Schema changes require explicit versioning.
- Exact dependency versions are deferred to Sprint 1 review.

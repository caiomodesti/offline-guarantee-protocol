# Sprint 4 — Claims

Status: **PASS**
Scope boundary: claim collection only; stopped before Sprint 5 reconciliation

## Outcome

Sprint 4 implements permissionless claim relay without trusting the relayer. The program verifies the exact canonical credential through Solana's native Ed25519 program, checks authoritative session/domain/economic fields, binds settlement to the signed merchant, enforces the claim deadline, proves parent reachability, and persists compact claim/edge indexes. It does not reconstruct a DAG, classify forks, allocate collateral, settle, revoke, release, or withdraw.

The lifecycle contradiction between runtime-derived `issued_at` and pre-transaction portable signatures was corrected in [ADR-0014](adr/0014-post-confirmation-portable-authorization.md). Claim verification placement and indexing are frozen in [ADR-0015](adr/0015-sprint-4-claim-verification.md).

## Implementation

### Session/domain correction

- `ProtocolConfig` stores `network_id` and the configured 32-byte cluster genesis hash.
- `create_offline_session` derives canonical genesis bytes/hash from `Solana Clock` facts on-chain.
- `register_device_authorization` is owner-only, one-shot, and pause-gated.
- Claims remain disabled until the portable authorization hash is registered.

### Claim transaction

The transaction layout is exactly:

```text
instruction N-1: native Ed25519 verifier
instruction N:   OGP submit_claim(canonical_payload[410], signature[64])
```

The verifier must contain one descriptor and reference the device public key, signature, and message inside instruction `N`. `submit_claim` rejects wrong indexes, offsets, sizes, programs, duplicated/embedded unchecked messages, byte substitution, and schema drift.

### Persistent indexes

| Record | PDA | Meaning |
|---|---|---|
| `Claim` | `claim/session/credential_hash` | Exact signed wrapper; replay key and diagnostic status |
| `StateEdgeRecord` | `edge/session/parent/sequence/child` | One economic transition, representative hash, wrapper count, future allocation fields |
| `OfflineSession` counters | existing session PDA | Aggregate unique-edge exposure and unique edge count |
| `ClaimSubmitted` | event | Rebuildable index feed with claim, edge, merchant, amount, status and counters |

Exact credential replay returns `DuplicateCredential`. A distinct valid wrapper for an existing edge is stored as diagnostic `Rejected/DuplicateStateEdge`; it cannot increment exposure. The edge's representative hash is the unsigned lexicographic minimum, independent of arrival order.

## Acceptance matrix

| Requirement | Evidence | Result |
|---|---|---|
| Claim submission | Native verifier plus persisted Claim/StateEdgeRecord | PASS in validator |
| Duplicate protection | Exact replay failure; distinct-wrapper/same-edge counter test | PASS in validator |
| Merchant binding | Wrong destination runtime rejection | PASS in validator |
| Expiry validation | Solana deadline plus signed metadata range/session expiry checks | PASS in validator |
| Parent reachability | Genesis sentinel or validated parent edge PDA | PASS in validator |
| Atomic rollback | Invalid parent/pause/signature leave no accounts/counter changes | PASS in validator |
| Indexing strategy | Strict SDK decoders verify owner, size and discriminator | PASS in host and validator |
| Existing behavior | 29 TypeScript, 6 vectors, Rust conformance, 14 program tests | PASS locally and in clean Linux CI |
| SBF compilation | Pinned remote Linux build | PASS |

## Runtime proof

The clean Linux acceptance run is [GitHub Actions run 31616694998](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31616694998), commit `cd2f0cf`.

| Evidence | Value |
|---|---|
| Rust | `rustc 1.97.1`; `cargo 1.97.1` |
| Solana/Agave | `solana-cli 3.1.10` |
| Anchor | `anchor-cli 1.0.2` |
| Node / pnpm | `v22.17.0` / `11.16.0` |
| Runtime program ID | `4KN4aotHPbiwuhmCmpnVpCHHwQQTwzFznLRCcYXPu1Sz` (ephemeral clean-run key) |
| SBF artifact | `offline_guarantee.so`, 424,032 bytes |
| SBF SHA-256 | `7d2d58dc618c3e49e18624284fc0c7221d562fbf205dd206470cb905e807b06b` |
| `submit_claim` compute | 24,254 CU |
| Runtime assertions | 23/23 PASS, including all Sprint 3 invariants and Sprint 4 claims |

The RPC returned `null` compute-unit metadata for the older Sprint 3 instructions in this run; their previously recorded baselines remain valid. The new `submit_claim` path produced an explicit 24,254-CU baseline.

## Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
cargo fmt --manifest-path programs/offline-guarantee/Cargo.toml -- --check
cargo clippy --manifest-path programs/offline-guarantee/Cargo.toml --all-targets -- -D warnings
anchor build
anchor test --validator legacy
```

Windows uses the checked-in remote Linux workflow for the last two commands because the supported SBF toolchain is not installed natively.

## Hostile audit

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| Critical | Certain in the previous lifecycle | Genesis/auth must bind authoritative time | Wallet could not predict `Solana Clock` timestamp | On-chain genesis derivation plus post-confirmation one-shot authorization | FIXED — ADR-0014 |
| High | Practical with a permissive parser | Only the exact signed payload is accepted | Ed25519 descriptors can reference other instruction data | One descriptor; exact program/index/offset/length/byte checks | FIXED / runtime PASS |
| High | Practical for a compromised device | One economic edge cannot multiply exposure | Signed metadata can change wrapper hash without changing child state | Separate edge PDA and one-counter rule | FIXED / runtime PASS |
| Medium | Practical relayer substitution | Merchant destination is immutable | Relay signer is intentionally permissionless | Compare account destination with signed merchant; payer self-merchant rejected | MITIGATED |
| Medium | Operational | Domain separation depends on correct cluster configuration | Solana exposes no on-chain genesis-hash sysvar | Admin config is explicit, emitted, decoded in runtime, and checked on every claim | OPEN RISK |
| Medium | Operational | Reserved collateral remains safe but usable | Client may abandon lifecycle before authorization registration | Claims stay disabled and collateral remains reserved; recovery/close belongs to later lifecycle sprint | DEFERRED |
| Medium | Practical DoS at scale | Timely merchants should submit | Every unique wrapper/edge pays rent and locks the session counter | Relayer funds accounts, depth is capped, correctness stays serialized | OPEN RISK — benchmark/compression later |
| Medium | Merchant data loss | Hash-only claims remain auditable | Program does not store 474-byte full credentials | Merchant retention plus rebuildable account/event index | OPEN RISK — durable evidence storage deferred |
| Low | Limited to later dust ordering | Arrival-independent allocation | Device can grind authenticated metadata hashes | Face-value exposure remains one edge; effect limited to dust tie-break | ACCEPTED MVP RISK |
| Low | Indexer integration | Claim/edge bytes must be decoded unambiguously | Manually initialized accounts are not auto-discovered by the Anchor IDL | Canonical SDK checks owner, exact size, discriminator and fixed offsets; host/validator tests | MITIGATED |
| Informational | Test harness only | Runtime evidence must be deterministic | `processed` reads and one-second clock margins produced false negatives | Claim transactions use `confirmed`; runtime bounds use safe margins; exact boundary remains unit-tested | FIXED |
| Informational | Local upgrade only | Account decoding compatibility | Config/session layouts and enum tags changed before any devnet deployment | Reset ephemeral local state; no production/devnet accounts exist | DOCUMENTED |

## Known limitations

- Certificate and wallet-authorization signatures are required for offline merchant acceptance. Per-claim on-chain verification uses the stronger authoritative session plus registered authorization hash and device signature; it does not replay the certificate bytes.
- `submitted_slot` and `created_at` never prioritize a claim. `created_at` is only signed range metadata.
- Economic counters may exceed `branch_spending_limit` across forks by design; coverage is capped later by `collateral_coverage_cap`.
- Reconciliation, fork records/classification, finalization, allocation, settlement, conflict state and revocation remain untouched.

## Files changed

- `programs/offline-guarantee/src/{claims,errors,lib,state}.rs`
- `programs/offline-guarantee/Cargo.toml`, `Cargo.lock`
- `packages/protocol-sdk/*`, `tests/protocol-sdk/accounts.test.ts`
- `tests/runtime/{validator.ts,tsconfig.json}`
- `docs/adr/{0014,0015,...}`, `docs/{architecture,protocol}.md`
- `README.md`, `.superstack/build-context.md`

## Sprint boundary

Sprint 4 is complete. Sprint 5 has not started; reconciliation, fork classification and finalization remain outside this implementation and require explicit review before work begins.

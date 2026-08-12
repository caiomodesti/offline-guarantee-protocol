# Sprint 3 — Solana Collateral Core

Status: implementation complete; hostile audit recorded; stopped before Sprint 4  
Date: 2026-08-11

## Delivered behavior

The Anchor program now owns the authoritative pre-offline lifecycle:

1. initialize a singleton protocol config;
2. pause or unpause through separated authorities;
3. create an opaque identity-backed user profile;
4. create PDA-controlled classic SPL collateral custody;
5. deposit settlement tokens with checked accounting;
6. create exactly one active offline session while atomically reserving its complete coverage cap.

Claims, fork evidence, reconciliation, settlement, revocation, reserve release, and withdrawal were not implemented.

## Accounts and exact allocated sizes

Sizes include the 8-byte Anchor discriminator.

| Account | PDA seeds | Bytes | Authoritative purpose |
|---|---|---:|---|
| `ProtocolConfig` | `config` | 194 | roles, settlement mint, fixed ratio/duration/depth, pause |
| `UserProfile` | `user`, owner | 163 | opaque identity commitment, access gate, risk counters, active session |
| `CollateralVault` | `vault`, owner, mint | 130 | protocol deposit/reserve/settlement accounting |
| vault SPL account | `vault-token`, vault | SPL-defined | actual custody; authority is the vault PDA |
| `OfflineSession` | `session`, owner, session ID | 344 | immutable economic/time/device commitments and future reconciliation fields |

## Frozen MVP parameters

| Parameter | Value | Enforcement |
|---|---:|---|
| minimum collateral ratio | 30000 bps (300%) | fixed during config initialization |
| maximum session duration | 10800 seconds (3h) | Solana clock versus requested expiry |
| claim grace period | 21600 seconds (6h) | deadline derived on-chain |
| maximum branch depth | 32 | copied from config into session |
| coverage cap | exactly `collateral_locked` | derived, never accepted from caller |
| concurrent sessions | one per profile | nonzero `active_session` blocks creation |

The three economic quantities remain distinct:

- `branch_spending_limit` bounds one valid offline path;
- `aggregate_offline_exposure` is initialized to zero and will count distinct eligible economic edges across branches in later sprints;
- `collateral_coverage_cap` bounds total protocol payout and equals the collateral reserved for this MVP.

## Instruction and event contract

| Instruction | Required authority | State effect | Event |
|---|---|---|---|
| `initialize_protocol` | admin | creates fixed singleton config | `ProtocolInitialized` |
| `set_paused` | admin/emergency to pause; admin to unpause | changes global pause bit | `ProtocolPauseChanged` |
| `create_user_profile` | configured identity authority | creates opaque profile | `UserProfileCreated` |
| `create_vault` | owner | creates vault and PDA-controlled token account | `CollateralVaultCreated` |
| `deposit_collateral` | owner | SPL transfer then checked protocol accounting | `CollateralDeposited` |
| `create_offline_session` | owner | reserves collateral, activates session, links profile | `OfflineSessionCreated` |

No Sprint 3 event can trigger the four final attack-demo messages. Those remain bound to later authoritative claim/reconciliation events; the dashboard may not infer them from these setup events.

## Security invariants implemented

```text
collateral_coverage_cap = collateral_locked
reserved_amount <= deposited_amount
reserved_amount <= actual_vault_token_balance
collateral_locked * 10_000 >= branch_spending_limit * minimum_ratio_bps
claim_submission_deadline = expires_at + claim_grace_period
0 < expires_at - SolanaClock.now <= max_session_duration
profile.active_session is empty before activation
```

The ratio uses `u128`, counters use checked addition, the session ID and commitment hashes cannot be all-zero, and the device key cannot equal the payer wallet. Offline timestamps are not consulted.

## Tests and verification

- 13 native Anchor/Rust tests cover exact ratios, undercollateralization, `u64` product safety, checked deadlines, duration bounds, deposit overflow, vault/book balance divergence, reservation bounds, authority separation, emergency-pause asymmetry, session material, and exact account allocation sizes.
- 26 TypeScript tests include the new rule rejecting a signed coverage cap smaller than locked collateral.
- Six golden vectors were regenerated and independently verified by the Rust conformance crate.
- Direct Anchor host compilation succeeds.

Reproduction:

```shell
corepack pnpm install --frozen-lockfile
corepack pnpm check
cargo fmt --manifest-path programs/offline-guarantee/Cargo.toml -- --check
anchor build --ignore-keys
```

On this Windows host, `anchor build` stops before SBF compilation because `cargo-build-sbf`/Agave CLI is unavailable natively. Official Solana tooling recommends WSL for Windows. Native Rust compilation and tests pass; SBF compilation and validator-backed CPI tests remain an `OPEN RISK`, not a claimed success.

## Hostile self-audit

1. **OPEN RISK — no SBF artifact or validator-backed CPI test on this host.** Anchor macros and host code compile, but classic SPL transfer/account constraints have not yet executed inside an SVM test validator. This must be closed in WSL/CI before devnet.
2. **OPEN RISK — development program ID lifecycle.** The declared ID matches a local ignored deployment keypair. A clean clone must generate a new dev keypair and run `anchor keys sync`, or build with `--ignore-keys`. No deployment key is committed.
3. **OPEN RISK — settlement mint governance.** A malicious or frozen demo mint can make nominal collateral economically worthless or unavailable. The program checks token units, not fiat backing.
4. **DEFERRED — reserved collateral cannot be released.** This is safe but locks funds until the later finalization/withdrawal instructions exist.
5. **DEFERRED — certificate issuance is off-chain.** The stored issuer role does not yet produce or verify a certificate on-chain; Sprint 1 verification assumes clients trust the configured key.
6. **DEFERRED — authority rotation.** Lost admin/identity/emergency keys cannot be rotated in Sprint 3.
7. **DECIDED FOR MVP — direct SPL donations.** They may make actual balance exceed accounting but do not create withdrawable/accounted collateral.
8. **DECIDED FOR MVP — classic SPL only.** Transfer-fee and Token-2022 semantics are rejected by the `Program<Token>` constraint.
9. **DECIDED FOR MVP — conservative single session.** This avoids shared-vault cross-session races until full release/withdrawal semantics are implemented.

### What would invalidate this implementation direction?

- SVM execution reveals that the PDA token authority or account constraints cannot be made reliable within transaction limits.
- Safe claim processing requires releasing or spending more than the reserved coverage cap.
- The configured token cannot provide stable, transferable collateral for the intended economic guarantee.
- Certificate issuance cannot be bound reliably to the exact on-chain session fields.
- A compromised device can alter an on-chain session or reserve without the owner signer.
- Solana adds no independently verifiable custody or state-transition property over a central database.

## Files changed in Sprint 3

- `Cargo.toml`, `Cargo.lock`, `Anchor.toml`
- `programs/offline-guarantee/Cargo.toml`
- `programs/offline-guarantee/src/{lib,errors,math,state}.rs`
- `.gitignore`, `package.json`
- `packages/credentials/src/index.ts`
- `tests/crypto/{fixture,protocol.test}.ts`
- `scripts/generate-vectors.ts`, `fixtures/golden-v1.json`
- `docs/{product-spec,protocol,threat-model}.md`
- `docs/adr/0012-sprint-3-collateral-core.md`
- `docs/sprint-3-report.md`

## Acceptance result

Sprint 3 behavior and host tests are complete. Acceptance for devnet deployment is withheld until SBF build plus validator-backed token CPI tests pass. No Sprint 4 implementation was started.

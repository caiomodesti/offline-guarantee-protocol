# Sprint 3 Runtime Acceptance Gate

Status: **PASS — authorized to request review before Sprint 4**  
Date: 2026-08-12  
Authoritative run: [GitHub Actions run 31587518880](https://github.com/caiomodesti/offline-guarantee-protocol/actions/runs/31587518880)  
Tested commit: `ad986a29420b1820d6cee551ae4b60890ce012b4`

This is the runtime Definition of Done for Sprint 3. It is not a new Sprint 3.5, does not authorize devnet deployment, and does not start Sprint 4.

## Environment

The test ran from a clean checkout on an ephemeral private `ubuntu-24.04` GitHub Actions runner.

| Tool | Exact version |
|---|---|
| Rust | `rustc 1.97.1 (8bab26f4f 2026-07-14)` |
| Cargo | `cargo 1.97.1 (c980f4866 2026-06-30)` |
| Solana/Agave CLI | `3.1.10 (src:7bc9c805; feat:1620780344)` |
| Anchor CLI | `1.0.2` |
| Node | `22.17.0` |
| pnpm | `11.16.0` |
| Runtime | `solana-test-validator`, forced with `anchor test --validator legacy` |

The wallet and deployment keypair were generated inside the runner, synchronized with `anchor keys sync`, never committed, and destroyed with the runner. The ephemeral program ID for this evidence is `4pWPVFKsELJGFvycHAm638aEQeLEtpQZ5rGS6HLajxgX`. A clean development clone follows the same lifecycle; it must not use `--ignore-keys` as a permanent workaround.

## SBF build

| Evidence | Result |
|---|---|
| `anchor build` | PASS |
| Artifact | `target/deploy/offline_guarantee.so` |
| Size | 322,224 bytes |
| SHA-256 | `ae14965b38d210c5cd599319f850f6ac6ca3844618f70634487a507c6a9f4113` |
| Unsafe stack warning | absent after boxing `OfflineSession` in the account parser |

The first runtime attempt revealed a 4,216-byte stack offset in `CreateOfflineSession::try_accounts`, above Solana's 4,096-byte limit. Moving the 344-byte session account wrapper to `Box<Account<OfflineSession>>` removed the warning without changing seeds, layout, ownership, or economic semantics.

## Validator tests

| Runtime property | Result | Evidence |
|---|---|---|
| initialization | PASS | fixed 30,000 bps ratio, 10,800s duration, 21,600s grace, depth 32, unpaused |
| authority separation | PASS | identity creates profile; random signer fails; emergency cannot unpause; admin can |
| PDA token custody | PASS | decoded SPL authority equals `CollateralVault` PDA |
| real SPL deposit CPI | PASS | owner `1000 -> 700`, vault `0 -> 300`, accounting `300` |
| direct donation | PASS | actual balance `350`, protocol accounting remains `300` |
| exact 300% session | PASS | `300/100`, cap derived as `300`, full reserve created |
| below 300% | PASS | `299/100` rejected with no state residue |
| accounting vs actual balance | PASS | reservation `320` rejected although actual balance is `350`, because accounting is `300` |
| reserve above real balance | documented unreachable | no legitimate Sprint 3 instruction can make accounted deposits exceed actual SPL balance |
| one active session | PASS | second session and second reservation rejected |
| Solana Clock | PASS | expired and >3h fail; valid and exact 3h pass; deadline is expiry + 21,600s |
| pause gate | PASS | profile, vault, deposit, and session creation fail without corruption |
| session rollback | PASS | failed ratio and stale-identity cases preserve reserve and active-session link |
| deposit rollback | PASS | failed CPI preserves SPL balances and protocol accounting |
| PDA signing boundary | PASS | user, admin, and emergency keys cannot transfer PDA-controlled collateral |
| stale identity | PASS | session expiry cannot exceed identity expiry |

All 15 structured runtime checks passed. The existing suite also passed from the clean checkout: 26 TypeScript tests, Rust conformance over six golden vectors, and 13 program tests. Golden vectors were not changed to obtain runtime success.

## CPI proof

Validator logs contain nested execution of classic SPL Token `TransferChecked`. The successful deposit consumed 20,231 program compute units, while the SPL Token CPI consumed 6,174 units. Decoded post-transaction balances prove the CPI effect and the subsequent protocol bookkeeping.

## PDA custody proof

The real classic SPL token account was decoded after `create_vault`:

```text
token_account.mint      = configured settlement mint
token_account.authority = CollateralVault PDA
```

External transfer attempts signed by admin or emergency authority failed. A PDA cannot make an external Ed25519 signature; only the program can invoke a future signed CPI using the correct seeds and bump.

## Economic invariant proof

The runtime preserved:

```text
collateral_coverage_cap = collateral_locked
reserved_amount <= deposited_amount
reserved_amount <= actual_vault_token_balance
collateral_locked * 10_000 >= branch_spending_limit * 30_000
identity_expires_at >= session.expires_at
```

Direct donations increase custody but not `deposited_amount`. Therefore they cannot silently create protocol-recognized collateral. The reverse divergence (`deposited_amount > actual balance`) cannot be produced by legitimate Sprint 3 instructions because deposits update accounting only after successful `transfer_checked` and balance reload.

## Clock proof

`issued_at` comes exclusively from `Solana Clock`. Device timestamps are not accepted as authoritative order. `expires_at` must be strictly later than the runtime clock, no more than 10,800 seconds later, and no later than the profile identity expiry. `claim_submission_deadline` is derived on-chain as `expires_at + 21,600`.

## Atomicity

Runtime failures confirmed Solana transaction rollback:

- `299/100` session: no session account, reserve change, or active-session link survives;
- session outliving identity: reserve and active-session link remain unchanged;
- failed deposit CPI: owner balance, vault balance, and `deposited_amount` remain unchanged;
- paused operations and duplicate sessions leave no partial state.

## Compute baseline

The RPC transaction lookup used by the JSON reporter returned no retained transaction, so its compute fields are `null`. The uploaded validator program log is authoritative and records representative successful executions:

| Instruction | Program compute units |
|---|---:|
| `initialize_protocol` | 8,481 |
| `set_paused` | 4,574 |
| `create_user_profile` | 10,538 |
| `create_vault` | 22,133–28,133 |
| `deposit_collateral` | 20,231 |
| `create_offline_session` | 22,996 |

Variation in vault/profile setup reflects account initialization and test state. No instruction approached the 200,000-unit transaction budget. Future CI should parse validator logs into the structured JSON instead of relying on RPC retention.

## Hostile audit

| Finding | Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|---|
| SBF account parser exceeded stack | High | runtime-dependent undefined behavior | deterministic session creation | compiler reported offset 4,216 > 4,096 | boxed the large session account wrapper; clean SBF build has no warning | FIXED |
| session could outlive identity | High | owner creates session shortly before identity expiry | only valid identity authorizes full offline window | hostile review of expiry checks | require `identity_expires_at >= expires_at`; validator rollback test | FIXED |
| PDA seed collision | Low | no practical collision found | unique config/profile/vault/session custody | typed prefixes plus owner/mint/session ID; runtime PDA creation | retain exact prefixes and add collision/property tests as account families grow | PASS |
| signer substitution | Low | constrained signers rejected | authority separation and owner control | random identity signer and admin/emergency custody attempts fail | Anchor `Signer`, `has_one`, and PDA constraints | PASS |
| mint/token account substitution | Low | constrained mismatches rejected | single settlement asset and correct custody | decoded mint/authority; constraints bind config, vault and token account | classic SPL typed accounts and explicit equality constraints | PASS |
| direct donation accounting | Medium | anyone can donate SPL tokens | accounted collateral cannot inflate silently | runtime balance 350 vs accounting 300 | keep accounting authoritative and actual balance as independent lower bound | DECIDED FOR MVP |
| arithmetic/timestamp overflow | Low | malformed extreme inputs | bounded liability and deadlines | checked math host tests plus runtime boundaries | `u128` ratio products and checked additions | PASS |
| duplicate session/partial reserve | Low | repeated owner request | one active session and atomic reserve | duplicate and failed-session runtime rollback | active-session guard plus Solana atomicity | PASS |
| pause/authority confusion | Low | unauthorized signer | emergency cannot unpause or move funds | runtime authority matrix | separate stored roles and asymmetric pause rule | PASS |
| program ID lifecycle | Medium | operational misconfiguration | artifact executes under intended ID | clean ephemeral key generation + `anchor keys sync` | documented reproducible lifecycle; no committed private keys | MITIGATED |
| malicious/frozen settlement mint | High | malicious mint authority or unsuitable asset | economic value and transferability | program validates token units, not external value | curated classic SPL mint for demo; production mint governance deferred | OPEN RISK |
| account reinitialization/size mismatch | Low | duplicate PDA init | account integrity | duplicate creation fails; frozen size tests pass | `init` with deterministic PDA seeds and exact `SPACE` tests | PASS |
| CPI differs from host assumptions | Low after test | runtime-only | real custody/accounting | real validator `TransferChecked` and balances | keep validator gate mandatory in CI | PASS |

No claims, reconciliation, settlement, release, withdrawal, or revocation behavior was introduced.

## Open risks

- The demo settlement mint's economic quality and freeze/mint governance remain trusted; this gate proves token mechanics, not asset value.
- GitHub Actions is an operational dependency for this Windows machine. The evidence is reproducible on pinned Linux, but WSL on the host remains broken.
- Compute JSON collection should be improved; the baselines currently come from the uploaded validator log.
- Release, withdrawal, claims, reconciliation, and settlement remain unavailable by schedule and must not be inferred from this PASS.

## Acceptance matrix

```text
SBF compilation                PASS
validator boot/deploy          PASS
protocol initialization       PASS
PDA token custody             PASS
real SPL deposit CPI          PASS
donation accounting           PASS
exact 300% session            PASS
undercollateralization        PASS
accounting/reserve limits     PASS
Solana Clock window           PASS
pause runtime enforcement     PASS
one-active-session rule       PASS
atomic rollback               PASS
full existing test suite      PASS
hostile audit                 PASS / limitations documented
```

## Devnet readiness

**NO-GO FOR DEVNET.** The Sprint 3 Runtime Acceptance Gate is PASS, but the immutable project schedule reserves full integration/devnet work for Sprint 12. This result authorizes only the project owner's review and, after explicit approval, the scheduled start of Sprint 4.


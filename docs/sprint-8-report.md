# Sprint 8 — Normal on-chain E2E report

Status: **IN PROGRESS**  
Source of truth: original Prompt Master, Sprint 8 only  
Started: 2026-08-15

## Fixed scope

```text
deposit
→ create session
→ airplane/network-disabled offline payment
→ merchant accepts and persists evidence
→ merchant reconnects
→ claim submitted
→ deterministic finalization and settlement
```

Sprint 8 does not implement the controlled rollback/fork demo (Sprint 9), dashboard (Sprint 10), Bluetooth (Sprint 11), or devnet deployment (Sprint 12).

## Entry evidence

Sprint 7's core offline communication gate passed on two physical Android phones with Wi-Fi and mobile data disabled. The owner observed the complete merchant → payer → merchant → payer camera exchange: branch `1000`, collateral display `3000`, payment `50`, locally verified merchant evidence, matching transport receipt, and payer branch `950`.

The later source-only history improvements have host-test evidence but no new APK was requested or produced.

## Decision 8.1 — fail-closed recovery

[ADR-0019](adr/0019-sprint-8-fail-closed-session-recovery.md) is accepted. Clearing app data, reinstalling, or losing the protected session key disables offline access. Recovery requires online authoritative chain state and a wallet signature. No fresh session/exposure is allowed while `profile.active_session` points to a prior session. Existing merchant claims and collateral reserves survive payer data loss.

## Current implementation increment

The first increment is a deterministic, side-effect-free access decision gate with explicit outcomes for:

- complete local session;
- missing protected key or branch state;
- partial/mismatched backup;
- unavailable chain state;
- prior active session;
- wallet authorization requirement;
- permission to provision a genuinely new session.

The protocol SDK now strictly decodes the fixed `UserProfile` and `OfflineSession` layouts. The recovery adapter verifies expected account addresses, program ownership, confirmed profile state, `profile.active_session`, the separate internal `session_id`, owner, device key, status, and revocation before feeding the decision gate. A hostile implementation check caught and corrected the initial temptation to treat the session PDA and internal `session_id` as the same identifier.

The Sprint 7 fixture remains isolated and labeled. It is not accepted as an input to the Sprint 8 on-chain path.

## Automated evidence

```text
TypeScript / Vitest               61 PASS across 9 files
Sprint 8 focused gate/adapter     17 PASS
Mobile TypeScript                 payer PASS; merchant PASS
Golden vectors                     6 PASS
Independent Rust conformance       1 PASS
Solana program Rust tests         16 PASS
```

No APK was generated for this increment, as requested. The physically installed Sprint 7 apps therefore do not yet contain the new recovery gate.

## Hostile audit — increment 8.1

| Severity | Exploitability | Affected invariant | Evidence | Mitigation | Status |
|---|---|---|---|---|---|
| High | Easy implementation error | Old session must block new exposure | Initial model used one field for PDA and internal ID | Separate and verify `activeSessionAccount`, session account address, and internal `sessionId`; regression tests | CLOSED |
| High | Easy if fixture leaks into production mode | Fresh capacity must be authorized on-chain | Sprint 7 app still contains compiled fixture | Gate rejects `development-fixture`; real app path must not call `loadDevelopmentSession` | OPEN INTEGRATION GATE |
| High | Ordinary clear-data/reinstall | Local loss must not cancel old obligations or reset balance | No local record plus authoritative active session | `ACTIVE_SESSION_BLOCKS_REPROVISIONING`, even with wallet signature | CLOSED IN DECISION ENGINE; VALIDATOR/MOBILE E2E PENDING |
| High | Rooted/fully compromised device | Monotonic offline branch | Attacker may restore both app data and protected key snapshot | Economic cap, fork evidence, reconciliation and Sprint 9 attack demo | OPEN RISK |
| Medium | Malicious/misconfigured RPC response | Recovery must use program-owned authoritative accounts | Raw account bytes alone are insufficient | Verify expected profile address, active session address, program owner, strict discriminator/size, and confirmation flag | PARTIALLY CLOSED; LIVE RPC WIRING PENDING |
| Medium | Local clock manipulation | Expired sessions must not appear valid indefinitely | Offline clocks are not absolute proof | Certificate/session expiry remains enforced by protocol/merchant validation; add explicit payer UX gate during integration without using it for branch ordering | OPEN INTEGRATION GATE |
| Medium | Standard MWA wallet versus local validator | Wallet-authorized Sprint 8 provisioning | MWA 2.0 officially defines mainnet/testnet/devnet chain identifiers, not localnet | Keep chronology: validator E2E uses an injected signer boundary; compile/test the MWA adapter; reserve public devnet proof for Sprint 12 | OPEN RISK |
| Low | Account layout drift | Recovery decoder correctness | Manual fixed offsets can drift after Rust changes | Frozen sizes/discriminators and decoder tests; runtime fixtures remain final proof | MITIGATED |

No claims, fork detection, settlement, withdrawal, Bluetooth, dashboard, or devnet behavior was added or reordered by this increment.

## Remaining acceptance gates

- injected wallet-signer local-validator deposit and session creation, plus compiled MWA boundary without claiming unsupported localnet wallet transport;
- fresh device key and portable authorization bound to the confirmed session;
- merchant reconnect and real claim submission;
- finalization and real SPL settlement;
- payer absence must not block merchant claim/settlement;
- clear-data/reinstall must not create new exposure while the old session exists;
- complete automated suite and hostile audit;
- reproducible commands and evidence.

Sprint 8 is not complete until the whole normal path above executes against the Solana runtime. No Sprint 9 functionality is authorized yet.

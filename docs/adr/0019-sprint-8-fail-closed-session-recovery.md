# ADR-0019: Sprint 8 fail-closed session recovery

- Status: Accepted for Sprint 8
- Date: 2026-08-15
- Classification: DECIDED FOR MVP

## Context

The payer may clear application data, reinstall the app, restore only part of an Android backup, or lose the per-session device key. None of those local actions erases the authoritative Solana session, its collateral reserve, or claims retained by merchants. Automatically recreating the Sprint 7 fixture or issuing fresh offline capacity after local data loss would permit accidental or deliberate rollback.

This decision does not change the Prompt Master's chronology. It defines the recovery behavior required by Sprint 8's normal on-chain end-to-end flow. The controlled malicious rollback and fork demonstration remain Sprint 9.

## Decision

The production/on-chain path fails closed:

1. an offline-ready session requires a complete locally verified provisioning record, the matching per-session device key in protected storage, and the persisted authenticated branch state;
2. missing, malformed, or mutually inconsistent local components disable offline payment immediately;
3. clearing data or reinstalling never recreates a session, fixture, device key, branch balance, or collateral entitlement automatically;
4. recovery requires connectivity, a confirmed read of the authoritative profile/session accounts, and a fresh wallet signature;
5. if `profile.active_session` identifies a non-terminal prior session, the app MUST NOT issue new offline exposure. It must recover the matching local authorization where safely possible or guide the user through the protocol's existing finalization/closure lifecycle;
6. claims already held by merchants remain valid and payable according to the claim window and coverage policy even when the payer never reconnects;
7. a new session may be provisioned only after the authoritative profile has no active session and the wallet explicitly authorizes the new lifecycle;
8. the Sprint 7 compiled fixture remains a labeled demonstration-only path and is forbidden in the Sprint 8 on-chain configuration.

The gate is based on authoritative identifiers and cryptographic bindings, never on a local boolean such as `isReady`.

## Deterministic recovery outcomes

| Evidence | Outcome |
|---|---|
| Complete, mutually consistent local session and device key | `OFFLINE_READY` |
| Any required local component missing or malformed while offline | `ONLINE_RECOVERY_REQUIRED` |
| Online but chain state unavailable/unconfirmed | `ONLINE_RECOVERY_REQUIRED` |
| Authoritative `profile.active_session` PDA exists but local account/session/key binding is absent or different | `ACTIVE_SESSION_BLOCKS_REPROVISIONING` |
| Authoritative active session differs from locally restored session | `ACTIVE_SESSION_BLOCKS_REPROVISIONING` |
| Authoritative profile has offline access revoked | `OFFLINE_ACCESS_REVOKED` |
| No authoritative active session, but wallet has not authorized provisioning | `WALLET_AUTHORIZATION_REQUIRED` |
| No active session plus confirmed wallet authorization | `NEW_SESSION_ALLOWED` |

## Trust and threat boundary

This prevents ordinary Android data clearing, reinstall, and partial backup restoration from silently resetting spend. It cannot prove monotonic local storage on a rooted or fully compromised device that can snapshot and restore both application data and protected keys. That remains an `OPEN RISK` bounded by branch limits, collateral, claim reconciliation, fork detection, and revocation; Sprint 9 must demonstrate the resulting fork.

`profile.active_session` is the session account PDA. It is distinct from the 32-byte protocol `session_id` stored inside that account and bound into signed objects. Recovery must verify both mappings rather than comparing those two values directly.

## Consequences

- A legitimate payer may temporarily lose offline access after device/data loss.
- Merchant settlement does not depend on payer recovery; a merchant or relayer may submit retained evidence before `claim_submission_deadline`.
- Recovery UX must explain the blocked prior session in Portuguese and must not promise that reinstalling cancels payments.
- Future account-abstraction or hardware-attested recovery may improve availability without weakening this fail-closed rule.

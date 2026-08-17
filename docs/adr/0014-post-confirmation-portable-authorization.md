# ADR-0014: Post-confirmation portable authorization lifecycle

- Status: Accepted for MVP
- Date: 2026-08-12

## Context

`issued_at` is authoritative only when read from `Solana Clock`. The genesis state includes `issued_at`, and `DeviceAuthorization` signs the same immutable session facts. Requiring the wallet to provide `genesis_state_hash` or `device_authorization_hash` to `create_offline_session` would require it to predict the exact runtime timestamp. That is not deterministic and contradicts the rule that device timestamps are not authoritative.

## Decision

Session activation is a two-step lifecycle:

1. the owner signs `create_offline_session`; the program reads `Solana Clock`, fixes `issued_at`, derives the canonical genesis hash on-chain, reserves collateral, and stores a zero authorization hash;
2. after confirmation, the wallet reads the finalized session, signs the portable `DeviceAuthorization`, and calls `register_device_authorization` once with its canonical hash;
3. the certificate issuer reads that finalized, authorized session and signs `SessionCertificate`;
4. claims are rejected until the nonzero authorization hash is registered.

`register_device_authorization` is owner-only, one-shot, pause-gated, and cannot change the device key, limits, collateral, timestamps, domain, or genesis. The transaction signer on session creation is the initial on-chain device authorization; the later portable signature exists for offline merchant verification.

## Consequences

- Runtime time remains authoritative and genesis is deterministic.
- A session is economically active before it is portable; clients must complete registration before showing offline mode as ready.
- Failure between the two steps leaves collateral reserved but creates no claim authority. Recovery/closure remains scheduled for the later lifecycle sprint.
- The certificate issuer still has no activation, collateral, claim, or settlement authority.
- This corrects an implementation-order contradiction; it does not renumber sprints or alter the economic policy.

## Implementation record — Sprint 8.6

The payer provisioning orchestrator now enforces the accepted lifecycle as a single fail-closed state machine. It accepts only an explicit wallet/MWA port that returns public keys, message signatures and transaction signatures; it never accepts a wallet secret. After both the creation and authorization-registration transactions it requires confirmation plus a fresh program-owned session read. The certificate response is validated against the configured trust root, registered authorization hash and every immutable confirmed session field before the protected device key is committed last.

The orchestration port is compiled and host-tested. A concrete Android MWA transport and deployed certificate-issuer endpoint remain integration gates; the port itself must not be presented as physical MWA proof.

# ADR-0020: Crash-consistent mobile economic state

Status: DECIDED FOR SECURITY HARDENING H1
Date: 2026-08-18

## Context

Payer and merchant state spans Android public application storage and protected SecureStore entries. Independent writes can be interrupted by process death, power loss or an individual storage failure. A payer must never expose a new branch unless its proof state, confirmed provisioning and protected session secret belong to one complete generation. A merchant must never acknowledge evidence unless the claim queue, outstanding challenge and protected device identity belong to one complete generation.

A public generation pointer alone is insufficient. Restoring an older AsyncStorage snapshot on the same device could otherwise point at an older protected component that still exists. The H1 design therefore needs a protected monotonic binding as well as public prepared/committed manifests.

## Decision

1. `@ogp/mobile-storage` owns the generic durability mechanism. Payer and merchant adapters define their exact components; UI code cannot publish the component records independently.
2. Every transaction receives a random 32-byte generation ID. Every component envelope contains its generation and name. The public manifest contains the namespace, phase, ordered component layout and SHA-256 of each payload.
3. The storage areas are intentionally distinct:

   - public: prepared manifest, committed manifest and non-secret components;
   - protected: the secret component and a protected journal containing `currentGeneration` and `pendingGeneration`.

4. A normal three-component commit executes in this order:

   ```text
   1  public prepared manifest
   2  protected journal: current = old, pending = new
   3  component A
   4  component B
   5  protected component C
   6  public committed manifest             <-- authority publication
   7  protected journal: current = new, pending = null
   8  remove public prepared manifest
   ```

5. Steps 7 and 8 are recovery cleanup. Failure after step 6 is reported as a successful commit with `cleanupPending=true`; retrying an already-published economic action is therefore not encouraged. A later load completes the protected journal and removes the prepared marker.
6. Before step 6, a failed initial transaction has zero authority. A failed update retains the previous complete generation. If step 6 completed but step 7 did not, the protected pending generation authorizes deterministic completion of that exact commit.
7. Load accepts a generation only when all conditions hold:

   - the public committed manifest is strict and canonical for this local format;
   - its generation equals the protected journal's current or trusted pending generation;
   - every required component is present in the configured storage area;
   - every component generation/name matches the manifest;
   - every payload SHA-256 matches the manifest.

   Any missing, mixed, malformed or unbound component returns `corrupt`; payer and merchant adapters convert that result into a fail-closed boot error. They never fall back to legacy records after a durable committed pointer exists.
8. Payer components are `provisioning`, `branch-state` and protected `device-secret`. Branch updates and receipt-delivery state use one serialized transaction.
9. Merchant components are `claims`, `outstanding-challenge` and protected `device-secret`. Evidence insertion and challenge removal are one serialized transaction. Receipt and sync metadata updates use the same store.
10. Existing pre-H1 records are read only when no durable generation or protected current generation exists. A complete legacy merchant tuple is migrated atomically. Public legacy merchant state without its protected key is rejected. Payer legacy material remains subject to the existing cryptographic recovery controller and migrates on its next confirmed write.
11. The explicit Sprint 7 payer fixture and isolated H0 instrumentation remain non-production graphs. They cannot create protocol liability and are not represented as H1 production durability evidence.

## Recovery matrix

| Observed state | Result |
|---|---|
| no committed pointer, no protected current generation | empty / legacy eligibility |
| prepared only, or protected `pending` without committed pointer | rollback; zero new authority |
| public committed = protected `current` | load complete current generation |
| public committed = protected `pending` | validate and complete the published commit |
| public committed differs from both protected generations | corrupt / fail closed |
| public committed exists but protected journal or secret is missing | corrupt / fail closed |
| protected current exists but public committed pointer is missing | corrupt / fail closed |
| component hash, name, generation or area is inconsistent | corrupt / fail closed |

## Consequences

- A crash cannot expose a partially written payer branch or merchant claim.
- Public-only restore/copy and public-pointer rollback cannot acquire authority without the matching protected journal and protected component.
- Transactions are serialized in each adapter, so concurrent UI actions cannot interleave generations.
- Immutable historical component envelopes are retained in H1. This favors safe recovery and auditability but can grow local storage; bounded garbage collection requires its own crash tests and is deferred until measurement demonstrates need.
- SHA-256 detects corruption and mixing; it is not a substitute for Android storage isolation against a fully compromised/rooted device.

## Trust assumptions and limitations

- Each individual AsyncStorage or SecureStore `set`/`remove` either succeeds or rejects; H1 does not assume cross-store atomicity.
- SecureStore remains bound to the application/device under the H0 backup policy. Full-device compromise, full protected-state rollback and runtime key extraction remain outside the software-only guarantee.
- H1 does not add hardware attestation, replace Ed25519, alter signed objects, or claim monotonic hardware storage.
- The development fixture paths remain demonstrations only. Production payer and merchant dependency-graph tests require their crash-consistent adapters.

## Protocol preservation

This ADR changes local mobile persistence only. It does not change canonical bytes, domain separation, signatures, certificate/credential schemas, collateral, branch economics, aggregate exposure, coverage, reconciliation, revocation, settlement, payouts or golden vectors.

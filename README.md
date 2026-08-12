# Offline Guarantee Protocol (OGP)

> We don't pretend offline double spending disappears. We detect it, collateralize it, and contain the damage.

OGP is an experimental protocol for economically bounded offline payments. A payer locks collateral on Solana, authorizes a temporary device key, and creates signed hash-linked payment credentials while disconnected. Merchants verify those credentials locally and submit claims after reconnecting. Reconciliation reconstructs the state graph, detects forks, applies a deterministic coverage policy, and revokes compromised offline access.

## Problem

A fully compromised offline device can reuse old local state and sign conflicting payments. Without an online coordinator or trusted hardware, the merchant cannot know whether another branch exists.

## Approach

- collateral custody and authoritative session state on Solana;
- a per-branch spending limit;
- portable session certificates and merchant-bound credentials;
- canonical Borsh encoding, SHA-256 hashing, and Ed25519 signatures;
- off-chain graph reconstruction with compact evidence verified on-chain;
- an arrival-order-independent coverage policy;
- atomic revocation when valid fork evidence is accepted.
- collect-then-finalize claims: no first-come-first-served payout during the claim window.

## What the MVP guarantees

- credential integrity and signer authenticity under the stated key assumptions;
- deterministic detection of valid sibling branches presented for reconciliation;
- replay-safe economic settlement for submitted claims;
- protocol liability no greater than the session's locked coverage cap;
- collateral cannot be withdrawn below outstanding possible liability;
- a payer with a proven fork cannot open another offline session.

## What it does not guarantee

- impossibility of double spending on a fully compromised device;
- that every eligible merchant is paid in full when eligible aggregate exposure exceeds the coverage cap;
- absolute creation order from offline timestamps;
- privacy from public Solana metadata;
- protection from merchant collusion, compromised identity, coerced keys, or unavailable claim submission;
- production readiness, real BRL backing, Pix integration, or legal finality.

Coverage is `FULLY_COVERED` when frozen eligible claims are within the cap and `INSOLVENT` otherwise; insolvency uses deterministic pro-rata settlement. `DOUBLE SPEND ATTEMPTED` is a labeled provisional cryptographic detection, while `FORK DETECTED` requires authoritative on-chain confirmation.

## Sprint status

Sprint 0 is frozen as the MVP design baseline. Sprint 1 implements the portable cryptographic core in TypeScript plus an independent Rust conformance harness. Sprint 2 implements the deterministic offline ledger. Sprint 3 implements the Anchor collateral core: protocol config and pause, opaque user profiles, PDA-controlled classic SPL vaults, checked deposits, and collateral-reserving offline-session activation.

There is still no claim/reconciliation program path, mobile application, issued demo token, QR transport, or dashboard. Sprint 4 has not started. SBF compilation and validator-backed CPI tests remain an explicit Sprint 3 open risk on this native Windows host.

## Specification map

- [Product specification](docs/product-spec.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Cryptography](docs/cryptography.md)
- [Threat model](docs/threat-model.md)
- [Risk model](docs/risk-model.md)
- [Demo contract](docs/demo-script.md)
- [Requirements traceability](docs/requirements-traceability.md)
- [Decision register](docs/decision-register.md)
- [Hostile self-audit](docs/sprint-0-audit.md)
- [Sprint 1 implementation report and hostile audit](docs/sprint-1-report.md)
- [Sprint 2 offline-ledger report and hostile audit](docs/sprint-2-report.md)
- [Sprint 3 collateral-core report and hostile audit](docs/sprint-3-report.md)
- [Architecture decisions](docs/adr/README.md)

## Local verification

```shell
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` builds all TypeScript packages, runs the adversarial Vitest suite, verifies the published golden vectors, and runs the independent Rust conformance test. Rust is pinned by `rust-toolchain.toml`.

Future demo targets, not implemented in Sprint 1:

```text
pnpm demo:reset
pnpm demo:normal
pnpm demo:attack
```

The demo reset will eventually create a mock two-decimal SPL mint, a verified payer, R$500.00 (`50000`) of locked collateral, a R$150.00 (`15000`) branch limit, and a three-hour session.

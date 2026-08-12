# ADR-0013: Remote Linux execution of the Sprint 3 Runtime Acceptance Gate

Status: DECIDED FOR MVP  
Date: 2026-08-11

## Context

The immutable project plan requires Sprint 3 to close its SBF/runtime acceptance gate before Sprint 4. The original execution plan selected WSL because the Windows host does not provide the supported SBF toolchain. The host's Windows component store is inconsistent: WSL 2 reaches Hyper-V Host Compute Service but cannot create a VM because required Hyper-V service material is absent. DISM cleanup and SFC completed, but repairing Windows safely would require a system repair and a complete user-data backup that is not currently available.

## Decision

Run the same Sprint 3 Runtime Acceptance Gate on an ephemeral `ubuntu-24.04` GitHub Actions runner in a private repository.

This is an execution-environment substitution only:

- Sprint numbering and schedule do not change.
- Sprint 3 acceptance criteria do not change.
- Sprint 4 remains blocked until the gate passes.
- Anchor `1.0.2`, Agave/Solana `3.1.10`, Rust `1.97.1`, Node `22.17.0`, and pnpm `11.16.0` are pinned.
- `anchor test --validator legacy` forces the real `solana-test-validator` backend rather than Anchor 1.x's default Surfpool backend.
- The CI development keypair is generated ephemerally, synchronized with `anchor keys sync`, never committed, and destroyed with the runner.
- No devnet or mainnet deployment is authorized by this ADR.

## Security and trust consequences

- GitHub and the Actions runner become operational trust dependencies for execution availability and artifact retention, not protocol correctness.
- The repository must remain private while this exception is in effect.
- No deployment key, production secret, PII, or user data may enter the repository or workflow.
- Runtime evidence includes the SBF artifact, SHA-256, exact tool versions, validator logs, compute-unit baseline, and structured test report.
- A passing remote run proves execution on the pinned Linux/Agave runtime; it does not prove this damaged Windows host can run WSL.

## Rejected alternatives

- Repeated WSL activation attempts: rejected after deterministic Hyper-V component failures.
- Manual registry/service reconstruction: rejected as unsafe and unsuitable evidence for a financial protocol.
- Windows repair without backup: rejected due to user-data risk.
- Surfpool-only acceptance: rejected because the gate explicitly requires validator-backed execution; the legacy validator is forced.

## Exit condition

This ADR is satisfied only when the private CI run produces all mandatory PASS evidence. Until then, the result remains `SPRINT 3 RUNTIME ACCEPTANCE: NO-GO` and Sprint 4 must not start.

## Outcome

Satisfied on 2026-08-12 by private GitHub Actions run `31587518880` at commit `ad986a29420b1820d6cee551ae4b60890ce012b4`. The SBF artifact, validator logs, exact environment, SHA-256, and 15 structured runtime checks were uploaded as artifact `9138025537` with archive digest `sha256:377b54868b3655ee8f60d3c4d3929c6edbd1c8fc95f6c83d27896be38202fd8b`.

`SPRINT 3 RUNTIME ACCEPTANCE: PASS`. Devnet remains unauthorized until its scheduled sprint, and Sprint 4 requires explicit project-owner approval.

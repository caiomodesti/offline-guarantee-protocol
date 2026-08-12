# Build context

```yaml
defi:
  protocol_type: custom
  program_id: 5Sa9K4yLThfeg9UN9sMsiQwNA2RKPbeDywgJvJ1rkgEm
  security_review: self
  oracle_integration: none
  emergency_pause: true
project:
  name: Offline Guarantee Protocol
  phase: sprint-4-claims
  settlement_asset: mock-spl-token
  money_representation: u64-minor-units
offline_ledger:
  package: "@ogp/offline-ledger"
  graph_model: authenticated-reachable-dag
  maximum_branch_depth: 32
  economic_idempotency: state-edge
  arrival_order_affects_result: false
runtime_acceptance:
  execution_environment: private-github-actions-ubuntu-24.04
  solana_version: 3.1.10
  anchor_version: 1.0.2
  validator_backend: solana-test-validator
  run_id: 31587518880
  tested_commit: ad986a29420b1820d6cee551ae4b60890ce012b4
  status: pass
```

OGP is a custom collateral, authorization, evidence, reconciliation, and settlement protocol. It is not an AMM, lending market, oracle-priced product, Pix integration, or production payment network. Sprint 3 and its pinned SBF/validator runtime acceptance gate pass. Sprint 4 implements claim collection and economic state-edge idempotency only; reconciliation remains Sprint 5 and economic resolution remains Sprint 6. Devnet remains scheduled for Sprint 12.

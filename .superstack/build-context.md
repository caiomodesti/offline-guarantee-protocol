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
  phase: sprint-8-normal-onchain-e2e
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
  run_id: 31728923466
  tested_commit: 359a9f40183ea1a350db1b5e1f010dbb569a84ac
  status: pass
mobile:
  platform: react-native-expo-standalone-preview
  expo_sdk: 57
  wallet_method: mwa
  qr_transport: fragmented-hash-bound
  runtime_mode_default: on-chain-fail-closed
  sprint_7_fixture_mode: explicit-build-time-opt-in
  standalone_preview_status: pass-payer-fixture-run-31848322396
  physical_device_tested: true
  physical_offline_exchange_status: pass-network-disabled-2026-08-15
  physical_restart_matrix_status: open-nonblocking-hardening
```

OGP is a custom collateral, authorization, evidence, reconciliation, and settlement protocol. It is not an AMM, lending market, oracle-priced product, Pix integration, or production payment network. Sprint 3 and its pinned SBF/validator runtime acceptance gate pass. Sprint 4 claim collection, Sprint 5 reconciliation, and Sprint 6 economic resolution are complete. Sprint 7's offline payer/merchant QR flow passed its core physical test. Sprint 8 normal reconnect/claim/settlement E2E is in progress, Bluetooth remains Sprint 11, and devnet remains Sprint 12.

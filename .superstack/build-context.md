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
  run_id: 31988270674
  tested_commit: ab1c833481d94cbd4d7b90876d4549c105a3358e
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
  physical_restart_matrix_status: blocked-h0-no-adb-and-live-recovery-adapter
  production_metro_hermes_bundle_status: pass-h0-2026-08-17
  production_android_apk_workflow_status: pass-run-31992215121-arm64-debug-signed-h0-only
  production_android_apk_sha256: aeb108722ff7d5819e1f9ba3b8f713e4f1d486899e735bd2d3b9e4aaebe0c24f
  physical_h0_harness_status: pass-ready-no-device
  android_backup_policy_status: pass-static-securestore-and-database-excluded-physical-pending
  production_fixture_separation_status: pass-source-graph-increment-8.7
  merchant_rpc_relayer_port_status: pass-source-increment-8.8
  merchant_durable_sync_ui_status: pass-source-increment-8.9
  local_claim_relayer_status: pass-host-and-validator-increment-8.10-run-31988270674
  merchant_production_fixture_separation_status: pass-source-graph-increment-8.9
```

OGP is a custom collateral, authorization, evidence, reconciliation, and settlement protocol. It is not an AMM, lending market, oracle-priced product, Pix integration, or production payment network. Sprint 3 and its pinned SBF/validator runtime acceptance gate pass. Sprint 4 claim collection, Sprint 5 reconciliation, and Sprint 6 economic resolution are complete. Sprint 7's offline payer/merchant QR flow passed its core physical test. Sprint 8 normal reconnect/claim/settlement E2E is in progress, Bluetooth remains Sprint 11, and devnet remains Sprint 12.

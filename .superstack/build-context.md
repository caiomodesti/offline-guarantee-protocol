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
  phase: security-hardening-h2-device-key-feasibility
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
  physical_restart_matrix_status: two-device-storage-lifecycle-and-public-copy-pass-live-recovery-pending
  production_metro_hermes_bundle_status: pass-h0-2026-08-17
  production_android_apk_workflow_status: pass-run-32090462706-arm64-debug-signed-h0-only
  production_android_apk_sha256: 6fb693cf091a77de1b61333a1f91175fa890dec1562218768dbbc369ecb9d140
  physical_h0_harness_status: pass-two-devices-user-scoped-foreground-verified
  h0_selective_storage_probe_status: pass-source-ci-apk-and-two-device-physical-run-32095043653
  h0_probe_apk_sha256: 7f54335e2b8359f2bb37df721c53900e1a76ffb3df696900b6688d36e756a18f
  h0_probe_package: protocol.ogp.payer.h0
  h0_gate_status: pass-physical-storage-lifecycle-mwa-public-cluster-proof-deferred-sprint-12
  h1_crash_consistency_status: pass-27-files-141-tests-protected-generation-journal
  h1_android_hermes_bundle_status: pass-payer-and-merchant-production-entrypoints
  android_backup_policy_status: pass-ci-local-static-and-two-device-clear-reinstall
  android_permission_policy_status: pass-ci-local-static-minimal-allowlist
  production_fixture_separation_status: pass-source-graph-increment-8.7
  merchant_rpc_relayer_port_status: pass-source-increment-8.8
  merchant_durable_sync_ui_status: pass-source-increment-8.9
  local_claim_relayer_status: pass-host-and-validator-increment-8.10-run-31988270674
  merchant_production_fixture_separation_status: pass-source-graph-increment-8.9
```

OGP is a custom collateral, authorization, evidence, reconciliation, and settlement protocol. It is not an AMM, lending market, oracle-priced product, Pix integration, or production payment network. Sprint 3 and its pinned SBF/validator runtime acceptance gate pass. Sprint 4 claim collection, Sprint 5 reconciliation, and Sprint 6 economic resolution are complete. Sprint 7's offline payer/merchant QR flow passed its core physical test. Sprint 8 normal reconnect/claim/settlement E2E is in progress, Bluetooth remains Sprint 11, and devnet remains Sprint 12.

# OGP claim relayer

Local Sprint 8 transport for permissionless `submit_claim`. It holds only a funded transaction-fee/rent payer; it has no authority to change the signed merchant, amount, session, state transition, coverage, reconciliation, or settlement.

## Required environment

```text
OGP_RPC_URL=http://127.0.0.1:8899
OGP_PROGRAM_ID=<deployed program public key>
OGP_NETWORK_ID=0
OGP_CLUSTER_GENESIS_HASH=<32 lowercase hex bytes>
OGP_RELAYER_KEYPAIR_PATH=<absolute path to an uncommitted 64-byte Solana keypair JSON>
OGP_RELAYER_HOST=127.0.0.1
OGP_RELAYER_PORT=8787
```

Generate a development-only keypair outside the repository, fund it on the selected cluster, and never commit or place its secret in an Expo variable. The server refuses a changed RPC genesis hash on every submission. Remote RPC endpoints require HTTPS; loopback HTTP is accepted for a local validator.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter claim-relayer build
corepack pnpm --filter claim-relayer start
```

Endpoints:

- `GET /healthz`
- `POST /v1/claims`

The HTTP process bounds request size, request time, concurrent submissions and per-address request rate. For any non-loopback deployment, terminate TLS in a hardened reverse proxy and add operator monitoring/budget controls. A response signature is not settlement evidence: clients must read and validate the expected program-owned Claim account.

Durable idempotency comes from the Claim PDA. Concurrent requests in one process are coalesced; cross-process races are resolved atomically by Solana. A retry after an already-confirmed claim receives `409 CLAIM_ALREADY_EXISTS`, after which the merchant performs its authoritative claim lookup.

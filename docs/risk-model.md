# Risk model V1

## Scope

The MVP uses fixed, inspectable rules. It does not use AI, credit scoring, external price oracles, reputation markets, or dynamic underwriting.

## Admission rules

A payer may create a session if and only if:

```text
protocol_paused == false
identity_attestation is valid under the configured mock issuer
offline_access_enabled == true
no other non-terminal session exists for the payer
0 < branch_spending_limit <= 15000
0 < session_duration <= 3 hours
claim_submission_deadline == expires_at + 6 hours
max_branch_depth == 32
collateral_coverage_cap == collateral_locked          // MVP v0.1
collateral_locked * 10000 >= branch_spending_limit * 30000
vault_unreserved_balance >= collateral_locked
```

Identity validity is checked at session creation. Later identity expiry or issuer-side revocation blocks future sessions once reflected on-chain but MUST NOT retroactively invalidate credentials under an already issued session; doing so would transfer issuer risk to offline merchants.

Checked `u128` intermediates are mandatory. The maximum `15000` is a protocol configuration for the demo mint, not a universal product constant.

Examples:

- `50000` collateral and `15000` branch limit: accepted (`33333` bps).
- `50000` collateral and `30000` branch limit: rejected (`16666` bps).

## Exposure model

The merchant sees three facts:

1. `branch_spending_limit`: maximum spend on the presented branch;
2. `collateral_coverage_cap`: maximum shared protocol payout for the entire session;
3. hidden-fork warning: `aggregate_offline_exposure` is unknown until reconciliation and may exceed both values.

The protocol bounds settlement, not the number or face value of promises a stolen device key can sign. A merchant acceptance is therefore a collateral-backed shared claim, not an exclusive reservation.

## Coverage status

After the claim set freezes:

```text
aggregate_offline_exposure <= collateral_coverage_cap => FULLY_COVERED
aggregate_offline_exposure >  collateral_coverage_cap => INSOLVENT
```

`FULLY_COVERED` means every eligible claim is paid in full. `INSOLVENT` means the exact deterministic pro-rata policy in `protocol.md` applies. Conflict is an independent sticky fact: a forked session may still be fully covered.

## Withdrawal rule

The risk engine cannot loosen the normative formula:

```text
withdrawable = max(0, actual_vault_token_balance - required_reserve)
```

Before final resolution, an open session reserves its entire unpaid coverage cap through the claim window and finalization. A zero-claim session releases reserve only after permissionless no-claims finalization.

The session lock is a portion of the vault, not necessarily its full balance. Example: a vault with `100000` may reserve `50000` for the only active/claimable session, leaving `50000` withdrawable if no other encumbrance exists.

## Revocation policy

On-chain confirmation of a second individually valid distinct child at one parent-key fork record causes immediate indefinite MVP revocation. No automatic cooldown or risk-tier downgrade exists. Existing and later timely historical claims remain payable. Reinstatement is **DEFERRED** and would require a separately specified governance/appeal process; an admin cannot silently clear conflict history.

## Fixed risk limits and limitations

| Risk | MVP control | Residual status |
|---|---|---|
| Honest overspend | branch remaining arithmetic | DECIDED FOR MVP |
| Forked aggregate overspend | coverage cap and pro-rata settlement | DECIDED FOR MVP |
| Multiple simultaneous sessions | one-open-session rule | DECIDED FOR MVP |
| Unsafe withdrawal | full-cap reserve formula | DECIDED FOR MVP |
| KYC compromise | opaque mock attestation only | OPEN RISK |
| Trivial self-merchant | require `payer_wallet != merchant_wallet` | DECIDED FOR MVP |
| Merchant collusion/multiple-wallet self-merchant | not solved | OPEN RISK |
| Device-key extraction | scoped key, expiry, cap, revocation after evidence | OPEN RISK |
| Claims above cap | deterministic partial settlement | DECIDED FOR MVP |
| Fabricated unreachable parents | full genesis-to-tip proof bundle, depth <= 32 | DECIDED FOR MVP |
| Prior-payment disclosure in proof bundle | accepted for correctness in MVP | OPEN RISK |
| Reinstatement after false/contested accusation | none | DEFERRED |
| Dynamic collateral pricing | no oracle; same mock mint for collateral/settlement | DEFERRED |

## Economic falsification questions

Before production, research must establish that merchants accept shared-cap semantics, ratios are competitive, observed conflict rates do not exhaust collateral, claim fees are economical, and users tolerate locked funds for session plus claim window. Failure on these questions can invalidate the project even if the code is correct.

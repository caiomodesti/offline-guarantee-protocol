# ADR-0006: Opaque identity and explicit metadata leakage

- Status: Accepted for MVP
- Date: 2026-08-10

## Context

The risk rule requires simulated KYC, while public PII would be unacceptable. Hash-only identifiers do not eliminate transaction correlation.

## Decision

Store only issuer, opaque attestation commitment, level/status, and validity metadata required by the profile. Never store CPF, name, document, address, photo, or raw KYC data. Make no MVP privacy claim and document wallet, merchant, amount, session, time, and hash correlation.

## Consequences

- Mock issuer remains trusted for identity status.
- Public metadata leakage is an open risk.
- Selective disclosure, confidential settlement, and private claims are deferred.

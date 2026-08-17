# OGP Spend Notes Architecture Study

Status: **RESEARCH ONLY — DEFERRED FROM THE APPROVED MVP**  
Decision date: 2026-08-16  
Protocol baseline: OGP v0.1, including the original Prompt Master and approved ADRs  
Implementation authorization: **NONE**

## Executive decision

**GO for an isolated, non-production prototype of the hybrid design. NO-GO for adoption into the OGP mainline at this time.**

The promising construction is not a new offline currency. It is a session-bound, merchant-bound, one-use *spend ticket* committed by a Merkle root and deterministically represented as an `EconomicEdge`. The edge can remain the economic fact and the approved coverage/settlement mathematics can remain unchanged. However, the current claim verifier assumes a path from the single session genesis. A useful Spend Note either retains that path for later claim submission or introduces multiple authorized note roots. The latter is the more useful prototype, but it is a real claim-admission and DAG extension that is **not approved for mainline**.

Spend Notes can materially improve two properties:

1. a merchant can verify authorization for one spend without receiving the payer's complete prior branch;
2. repeated use of one committed note produces a direct, stable duplicate identifier.

They do **not** prevent a malicious or rolled-back device from presenting the same right to multiple fully offline merchants unless a platform-specific hardware primitive actually enforces a single signature. Merkle membership proves issuance, not freshness or erasure. Collateral remains the mechanism that bounds protocol loss.

| Question | Classification | Decision |
|---|---|---|
| Current `EconomicEdge`, claims, DAG reconciliation and settlement | **DECIDED FOR MVP** | Remain authoritative and unchanged in the approved protocol. Research may model an adapter but cannot alter them. |
| Spend Notes in the production protocol | **DEFERRED** | No schema, account, program or mobile-flow change is authorized. |
| Isolated TypeScript/Rust prototype under `research/spend-notes/` | **DEFERRED — GO AFTER EXPLICIT AUTHORIZATION** | Build only after review of this study. |
| Merkle commitment with canonical SHA-256 hashing | **GO FOR PROTOTYPE** | Use a fixed ordered tree with distinct leaf/node prefixes. |
| Generic software-only one-time secret as double-spend prevention | **NO-GO** | It detects reuse later; it does not enforce one use offline. |
| Android hardware single-use key variant | **GO FOR CAPABILITY PROTOTYPE** | Optional tier only, subject to device capability and attestation. |
| Cross-platform hardware-enforced one-time use | **OPEN RISK** | No uniform Android/iOS primitive has been established. |
| Phone-to-phone NFC as universal transport | **OPEN RISK** | Android is promising; iOS eligibility and entitlements prevent assuming universal support. QR remains the fallback. |
| Cryptographic construction beyond standard hash, signature and Merkle membership | **REQUIRES CRYPTOGRAPHIC REVIEW** | No custom cryptography may be promoted from the prototype. |

---

## 1. Relevant OGP baseline

The approved OGP v0.1 model is intentionally preserved:

- a Solana session locks collateral and certifies one offline device key;
- `branch_spending_limit` bounds the sum of valid spends on any one linear branch;
- each signed `PaymentCredential` produces one `EconomicEdge` from a parent state to a resulting state;
- a fork is authenticated when the same session, parent state and sequence have different valid resulting state hashes;
- all unique eligible conflicting edges remain eligible; arrival order and offline timestamps do not choose a winner;
- claims are collected through `claim_submission_deadline` before deterministic finalization;
- `aggregate_offline_exposure` is the sum of unique eligible economic edges in the reconstructed DAG;
- `collateral_coverage_cap` is the maximum total protocol payout and equals `collateral_locked` in MVP v0.1;
- when exposure exceeds coverage, all eligible merchants share coverage by deterministic pro-rata allocation plus deterministic hash-ordered dust;
- the payer risk profile is revoked after an authenticated fork, while revocation does not erase merchant eligibility.

The current standalone proof bundle has a fixed 924-byte trust prefix (`SessionCertificate` 554 bytes plus `DeviceAuthorization` 370 bytes) and 474 bytes for every `PaymentCredential`. Raw size is therefore:

```text
current_bundle_bytes(depth d) = 924 + 474d
```

Examples, before QR framing/error correction:

| Branch depth | Raw bytes |
|---:|---:|
| 1 | 1,398 |
| 4 | 2,820 |
| 8 | 4,716 |
| 16 | 8,508 |
| 32 | 16,092 |

This linear growth and disclosure of branch history are the legitimate reasons to investigate a committed right that does not require the entire path.

## 2. Formal definition of an Offline Spend Note

An `OfflineSpendNote` is a **non-transferable authorization capability scoped to one OGP session**. It is not an asset, SPL token, NFT, wallet key, collateral claim by itself or freely circulating bearer instrument.

For the recommended prototype, define the canonical leaf payload:

```text
SpendNoteLeafV1 {
  domain: OgpDomain,
  root_version: u16,
  leaf_index: u32,
  note_nonce: [u8; 32],
  denomination: u64,
  settlement_mint: Pubkey,
  device_public_key: [u8; 32],
  valid_until: i64,
  one_time_public_key: Optional<EncodedPublicKey>
}
```

`OgpDomain` must retain the existing domain fields:

```text
protocol_name
protocol_version
schema_version
object_type = OfflineSpendNoteLeaf
network_id
cluster_genesis_hash
program_id
session_id
```

`note_id` and the stable redemption identifier are:

```text
leaf_bytes = CanonicalBorsh(SpendNoteLeafV1)
note_id    = SHA256(0x00 || leaf_bytes)
nullifier  = SHA256(
  "OGP_NOTE_NULLIFIER_V1" ||
  full_domain ||
  note_id
)
```

The note is usable only when all of the following hold:

1. its canonical leaf hashes to `note_id`;
2. its Merkle proof resolves to the root certified for the same session;
3. its mint, device key, validity and domain equal the certified session facts;
4. its denomination is nonzero and does not exceed the remaining value permitted by the accompanying `EconomicEdge`;
5. a payer device signature binds the note to one merchant, amount and fresh challenge;
6. the accompanying edge remains valid under all existing OGP rules;
7. the claim is submitted within the existing claim window.

Possession of the leaf or proof alone conveys no right to redirect collateral. Settlement still follows an eligible OGP claim.

## 3. Three candidate architectures

### Architecture A — committed bearer-secret notes

The session commits leaves containing `H(secret_i)`. At payment time the payer discloses `secret_i`, the merchant verifies the preimage and Merkle path, and `H(domain || secret_i)` becomes the nullifier.

**What the attacker must break:** nothing cryptographic if they can copy the secret before or after use. A copied valid secret is sufficient to reproduce the bearer capability unless the final payer signature also binds merchant and challenge.

**Maximum damage:** with merchant binding, copied storage can still cause multiple signed claims if the device key is usable after rollback. Eligible exposure may reach `k × denomination` for `k` conflicting merchants; total protocol payout remains at most `collateral_coverage_cap`, and merchants bear any uncovered amount. Without merchant binding, theft or forwarding is easier and this design is unacceptable.

Decision: **NO-GO as a standalone design.** A secret can make duplicate detection straightforward, but it does not provide enforceable single use. Disclosure also creates unnecessary theft risk.

### Architecture B — Merkle-committed hardware single-use keys

Each leaf commits a public key generated for exactly one note. The final merchant-bound authorization must be signed by that note key. On Android API 31+, `setMaxUsageCount(1)` can request a single-use private key; compatible secure hardware can enforce the count and feature flags report whether enforcement is hardware-backed. Other devices may enforce it only in software. Official Android documentation explicitly warns that support varies by hardware.

**What the attacker must break:** secure-hardware usage enforcement, attestation verification, platform isolation, or provisioning integrity. On unsupported hardware, they need only restore software state.

**Maximum damage:** if genuine one-use hardware enforcement holds, one note key cannot sign two different merchant challenges. If it fails or was only software-enforced, damage falls back to the copied-note case: aggregate eligible exposure may exceed the branch limit, but payout remains capped.

Advantages:

- strongest local prevention available in the researched primitives;
- merchant-specific signature makes theft and recipient substitution fail;
- direct, objective reuse evidence if duplicate signed objects somehow exist.

Costs and limitations:

- potentially one hardware key and attestation record per note;
- slower and resource-constrained StrongBox operations;
- capability begins at Android API 31 and varies by device;
- StrongBox and Apple Secure Enclave natively focus on P-256, while OGP v0.1 uses Ed25519;
- Apple documentation reviewed does not expose an equivalent persistent, hardware-enforced one-signature key for this application;
- attestation chain and revocation validation are online provisioning responsibilities and add trust roots.

Decision: **GO only as an Android capability experiment. NO-GO as a universal protocol requirement.** Any signature-suite addition is a protocol change requiring an ADR and cryptographic review.

### Architecture C — hybrid committed spend tickets plus EconomicEdges

The session commits a compact set of note leaves. At payment time the payer selects a note, receives a merchant challenge, and signs a `NoteSpendAuthorization`. That authorization is represented by an economic edge.

There are two integration subvariants:

- **C1 — auxiliary note:** the edge remains on the ordinary branch. The merchant can verify issuance without seeing history, but the full ancestor path must still be retained and later supplied for the current claim verifier. This improves selective disclosure at the point of sale only if a safe evidence-delivery mechanism exists; otherwise it merely moves the availability problem.
- **C2 — note-rooted edge:** every committed note defines an authorized synthetic parent state. Its one merchant-bound spend is an edge from that parent. Reusing the note creates two valid edges with the same session, parent and sequence but different resulting hashes — exactly shaped for the current fork predicate. Honest aggregate note capacity is constrained by `I <= B`. This avoids ancestor transfer but requires the claim/DAG layer to accept multiple certified note roots.

The prototype should prioritize C2 because it tests the actual size/privacy hypothesis. It must label the multiple-root adapter as research and must not patch production claim logic.

**What the attacker must break:** for forgery, SHA-256 second-preimage/collision resistance, canonical encoding, Ed25519/P-256 signature security or issuer/device trust. For double use, no primitive needs to be broken if software state can be copied or rolled back; the protocol detects the repeated `note_id` later.

**Maximum damage:** `aggregate_offline_exposure` can exceed both note issuance capacity and branch limit under authenticated reuse/forking, exactly as conflicting edges can today. Protocol payout remains bounded by `collateral_coverage_cap`; uncovered loss is deterministic merchant risk.

Decision: **recommended for an isolated prototype.** This is the only design that can deliver the privacy/proof-shape advantage while preserving `EconomicEdge` as the accounting unit and the approved settlement calculation. It does not preserve claim admission unchanged; that incompatibility is an explicit promotion gate.

## 4. Mandatory architecture comparison

| Property | Current EconomicEdge | Standalone Spend Note | Recommended hybrid |
|---|---|---|---|
| Security basis | Signed, hash-chained state transitions | Merkle membership plus note authorization | Existing edge checks plus Merkle membership and note authorization |
| Offline verification | Full trust material and path | Trust material, leaf, proof and final signature | Trust material, compact note proof and referenced edge |
| Proof growth | Linear in branch depth | Logarithmic in note count | Logarithmic note proof; edge history omitted from transfer when verifier has certified root |
| Branch state | Explicit remaining balance and parent chain | Must reinvent cumulative accounting | Existing branch state remains authoritative |
| Replay resistance | Exact replay deduplicated by edge identity | Nullifier deduplicates exact note reuse | Edge identity plus nullifier |
| Double-spend evidence | Same parent/sequence, different result | Same note/nullifier, different authorization | Both fork evidence and note-reuse evidence |
| Offline prevention | Honest local state only | Honest state; optional hardware one-use key | Same, with optional hardware tier |
| Reconciliation | Approved deterministic single-genesis DAG | New mechanism required | C1 keeps the DAG but retains path dependency; C2 needs certified multiple roots while retaining deterministic edge accounting |
| Solana state | Session + claim/edge records | Root plus note redemption state | Future root fields; existing claim/edge records can carry note commitment |
| Device state | Current branch and protected key | Unused-note set and keys/secrets | Current branch plus unused-note set |
| Rollback surface | Re-sign from restored parent | Reuse any restored note | Both surfaces; stable note ID makes reuse clearer |
| QR | Universal, but grows with depth | Compact if trust prefix is cached | Compact incremental payload; QR fallback retained |
| NFC | Large at deep paths | Better payload shape | Better payload shape without economic rewrite |
| Capital efficiency | No denomination fragmentation | Can burn change or overissue rights | Denomination policy can be conservative; edge amount remains exact |
| Merchant UX | More history to validate | Simple note membership | Simple note membership plus familiar OGP result |
| Payer UX | Exact amount | Selection/change complexity | Exact edge amount; note face value may be consumed |
| Privacy | Prior branch can be exposed | Prior history can be hidden | Prior history can be hidden while preserving claims |
| Implementation complexity | Existing and tested | High; new settlement semantics | Medium-high; additive prototype first |
| Attack surface | Current codec, signatures, DAG | New leaf, root, secret/key, nullifier logic | Adds those surfaces but avoids replacing reconciliation |

Standalone Spend Notes are therefore rejected. The meaningful comparison is current model versus additive hybrid.

## 5. Recommended hybrid model

### 5.1 Authority hierarchy

```text
collateral vault
  -> OGP session and its economic limits
    -> certified note_root and issuance_capacity
      -> SpendNoteLeaf membership
        -> merchant-bound NoteSpendAuthorization
          -> referenced EconomicEdge
            -> existing claim / DAG / settlement
```

The root is an authorization commitment, not a pool of independent money. `EconomicEdge` remains the only unit added to aggregate exposure.

For C2, define the authorized parent deterministically:

```text
note_parent_state_hash = SHA256(
  "OGP_NOTE_PARENT_V1" ||
  full_domain ||
  note_root ||
  note_id ||
  denomination
)

note_sequence = leaf_index
```

The resulting state commits the parent, sequence, merchant, exact amount, challenge and a terminal `note_remaining = 0`. A note is intentionally consumed in full even when `amount < denomination`. Two different valid spends of the same note necessarily share `note_parent_state_hash` and `note_sequence`; distinct merchant/amount/challenge data produce different resulting hashes and therefore formal fork evidence.

This parent is not accepted by the existing program today. The prototype may model it in an isolated adapter only.

### 5.2 Final merchant-bound authorization

```text
NoteSpendAuthorizationV1 {
  domain: OgpDomain,
  note_id: [u8; 32],
  nullifier: [u8; 32],
  note_root: [u8; 32],
  merchant: Pubkey,
  merchant_settlement_destination: Pubkey,
  merchant_challenge: [u8; 32],
  amount: u64,
  economic_edge_hash: [u8; 32],
  parent_state_hash: [u8; 32],
  resulting_state_hash: [u8; 32],
  sequence: u32,
  session_expires_at: i64,
  signature_suite: u8
}
```

The signed domain includes network, genesis hash, program ID, protocol/schema version, object type and session ID. This prevents replay across localnet/devnet/mainnet, deployments, protocol versions, object types and sessions.

`merchant_challenge` must be 32 random bytes generated from a CSPRNG and locally tracked against accidental reuse. Offline timestamps are metadata only and cannot establish which merchant came first.

### 5.3 Verification algorithm

A fully offline merchant accepts only if all checks pass:

1. decode every object canonically and reject trailing, missing or non-canonical bytes;
2. validate the issuer/wallet/device certificate chain against locally trusted roots;
3. require exact domain equality across certificate, root descriptor, leaf, authorization and edge;
4. verify session and certificate validity using the merchant's local policy, acknowledging local-clock uncertainty;
5. recompute the leaf hash and verify its indexed Merkle path to the certified root;
6. recompute `note_id` and `nullifier`;
7. require the merchant identity, settlement destination, amount and challenge to equal the merchant's request;
8. verify the payer-device or attested one-time-key signature;
9. validate the edge signature, amount and resulting hash and require its parent/sequence to equal the deterministic note parent/index; C1 instead requires the complete existing branch proof;
10. require `amount <= denomination` and reject zero value;
11. reject any locally seen challenge, authorization hash, note ID or nullifier;
12. durably persist the complete claim evidence before displaying success.

Local absence from the merchant database is not global proof of freshness. It only prevents reuse against that merchant instance.

## 6. Merkle commitment design

Use SHA-256 and an ordered, fixed-size tree. Following the well-known leaf/node separation used by RFC 6962:

```text
leaf_hash(x)       = SHA256(0x00 || CanonicalBorsh(x))
parent_hash(l, r)  = SHA256(0x01 || l || r)
```

The proof includes `leaf_index`, `tree_size` and ordered siblings. Do not lexicographically sort sibling pairs: position is part of the commitment. For a non-power-of-two number of leaves, either use the RFC 6962 tree shape exactly or pad to a power of two with a domain-separated empty-leaf rule fixed in the schema. The prototype should choose one rule, generate golden vectors in TypeScript and Rust, and reject all other shapes.

The certified root descriptor must include:

```text
root_version
root_hash
tree_size
issuance_capacity
denomination_policy_id
hash_algorithm_id = SHA256
leaf_schema_version
```

Changing a root creates a new root epoch and new note namespace. A root cannot be silently replaced within an active session.

Security claims are limited to membership and integrity. A Merkle proof says “this leaf was committed”; it does not say “this leaf has never been used.”

## 7. Serial, secret and nullifier design

### Serial and nonce

Use both a deterministic unique `leaf_index` and a 32-byte CSPRNG `note_nonce`. The index makes proof interpretation unambiguous; the nonce prevents predictable note identifiers and cross-user enumeration.

### One-time secret

A secret-preimage variant may be tested only as duplicate evidence:

```text
secret_commitment = SHA256("OGP_NOTE_SECRET_V1" || domain || secret)
```

The secret must be random, per-note, non-derivable from a master secret and excluded from backups. It must never authorize the wallet or vault. Nevertheless, revealing it gives every observer the same secret and does not enforce erasure. The recommended baseline does not need to reveal it; a signed note ID is sufficient.

### Nullifier behavior

- same nullifier + byte-identical authorization: exact replay; store once and do not add exposure twice;
- same nullifier + different merchant, challenge, amount or edge: authenticated note reuse, provided both signatures and memberships are valid;
- different nullifiers that reference the same valid parent/sequence with different results: existing authenticated fork;
- forged proof or invalid signature: invalid evidence, not a fork and not eligible exposure.

Nullifiers are deliberately linkable within the note: that is what permits duplicate detection. The domain and session binding prevent cross-session linking from a reused nonce, while root/session data still enable broader correlation.

## 8. Denominations and change

| Model | UX | Privacy | Proof/transport | Double-spend surface | State/hardware | Decision |
|---|---|---|---|---|---|---|
| Fixed denominations | Simple selection; poor exact change | Repeated patterns fingerprint users | One proof per note | One reusable right per note | Many notes/keys | Viable only with exact payment or burned remainder |
| Binary denominations | Exact integer composition with few note values | Combination leaks amount structure | Multiple leaves/proofs/signatures unless multiproof | More simultaneously reusable notes | More state and possibly keys | Prototype comparison only |
| Dynamically derived amount | Best payer UX | Reveals only exact amount | Compact | Becomes current reusable device authority unless hardware prevents rollback | Needs cumulative state | Not a true precommitted note; little gain alone |

### Change options

1. **Exact denominations:** safe capacity accounting, but poor UX and potentially many proofs.
2. **Burn remainder:** a 20-unit note can pay 13 and the unused 7 is permanently unavailable. Simple and safe, economically inefficient.
3. **Offline split/change notes:** unsafe unless the newly created notes remain cryptographically constrained by the consumed parent despite rollback. Otherwise both parent and change can be spent. **NO-GO without a reviewed construction.**
4. **Binary combination:** avoids change but sends several proofs; Merkle multiproofs may reduce bytes but add parser and verification complexity.
5. **Dynamic note:** is essentially an `EconomicEdge`; use the existing edge instead of inventing an equivalent object.

Recommendation for the first prototype: fixed notes with `amount <= denomination`, consume the entire note, and expose the burned remainder clearly. This is intentionally conservative and demonstrates security without solving every retail denomination problem.

## 9. Rollback analysis

Scenario: storage says notes A, B and C are unused; B is spent; the attacker restores the earlier snapshot and spends B again.

| Layer | Prevents second offline spend? | What it actually provides |
|---|---:|---|
| “used” flag in app storage | No | Honest-device UX only |
| Excluding state from cloud backup | No | Prevents ordinary backup restoration, not rooted/device-image rollback |
| Merkle membership | No | Proves B was issued |
| One-time secret disclosure | No | Stable post-reconnect duplicate evidence |
| Non-exportable session key | No | Prevents copying the key to another device; restored state can ask the same key to sign again |
| Merchant challenge binding | No | Makes each double spend attributable and non-redirectable |
| Current hash-chained edge | No | Produces a fork from the restored parent; directly detects it later |
| Android hardware-enforced `maxUsageCount=1` per note key | Potentially yes | Refuses a second signature if hardware support and enforcement are genuine |
| Online atomic redemption | Yes for later attempts | Consensus orders the first accepted claim; concurrent transactions serialize |

Android's rollback-resistance tag prevents restoration of a *deleted key blob* when supported; it is not by itself a monotonic counter over arbitrary application note state. The single-use-key API is the more relevant optional primitive. Because support can fall back to software, provisioning must verify the device capability and attested enforcement tier.

On Apple platforms, the Secure Enclave provides non-exportable P-256 keys, but the reviewed public APIs do not establish a persistent single-signature counter usable for this design. This is an inference from the documented surface, not a claim about undisclosed hardware internals.

Conclusion: software Spend Notes make reuse easier to identify but do not improve prevention over the current chain. They may worsen the *number of independently restorable rights* unless issuance is conservative. Hardware single-use notes could improve prevention on a supported Android tier, but cannot define the universal protocol.

## 10. Device copy analysis

### Copy before first payment

- Copying leaves, proofs and secrets is sufficient to reproduce the public note material.
- Merchant binding prevents a previously finalized authorization for merchant A from being claimed by merchant B.
- If the session signing key is exportable or compromised, each copy can create a fresh merchant-bound authorization.
- A non-exportable device key prevents remote copies from signing, but not a copy operating through the same compromised device.
- A per-note hardware single-use key can block the second signature on a capable device.

### Damage bound

Let `d_i` be note denomination, `k_i` the number of distinct valid merchant-bound uses of note `i`, and `E` the unique eligible edge set:

```text
nominal_note_reuse_exposure = Σ_i k_i × amount_i
aggregate_offline_exposure  = Σ_{edge e in E} amount(e)
protocol_payout             = min(aggregate_offline_exposure,
                                  collateral_coverage_cap)
```

There is no cryptographic upper bound on `k_i` for a fully compromised, software-signing device before reconnection. The economic bound applies to protocol payout, not to the sum of merchant expectations.

## 11. Malicious merchant and collusion analysis

| Attack | Result | Mitigation/status |
|---|---|---|
| Change 10 to 100 | Signature and leaf/edge checks fail | Prevented by canonical signed amount and committed denomination |
| Substitute merchant or payout destination | Signature check fails | Prevented by explicit recipient and destination binding |
| Claim same authorization twice | Same claim/nullifier is idempotent | Exact replay stored once |
| Sell authorization to merchant B | B cannot redirect settlement | Non-transferable merchant binding |
| Withhold payer receipt | Payer lacks independent merchant acknowledgement | Merchant must sign a receipt over authorization hash; **prototype requirement** |
| Invent note/serial | Merkle proof fails | Offline rejection |
| Colluding payer + merchant create excess claims | Valid conflicting edges may be eligible | Detect fork/note reuse, revoke payer, cap payout, deterministic allocation |
| Merchant front-runs its own evidence | Destination already fixed | No redirection benefit |
| Network attacker alters claim | Signatures/hashes fail | Integrity protected; availability remains an operational risk |

A merchant receipt does not determine arrival order or claim priority. It only proves that a particular merchant accepted and durably stored a particular authorization.

## 12. Privacy analysis

The hybrid has a real privacy advantage: a merchant can receive membership evidence for the selected right instead of the complete prior branch, so previous merchants, amounts and sequence history need not be disclosed through the transport.

Remaining correlation surfaces include:

- payer/session device public key and certificate;
- session ID and Merkle root reused across notes;
- merchant identity and settlement destination;
- exact or bucketed values;
- local and on-chain submission times;
- note IDs, nullifiers, edge hashes and claim accounts;
- issuer, mint, program and cluster;
- fixed-denomination combinations that fingerprint an envelope.

Stable nullifiers necessarily reveal repeated use of the same note. Publishing root or session identifiers links all claims in that session. No zero-knowledge proof is proposed. A future ZK design could prove membership, value constraints and session binding while selectively hiding leaf fields, but that is out of scope and would require a separate cryptographic architecture.

Privacy decision: **hybrid is materially better than sending full branch history, but it is not anonymous.**

## 13. NFC and proof-size analysis

### Estimated canonical sizes

The exact vNext schema is not approved, so these are engineering estimates, not wire-format commitments.

Assumptions for a 32-note tree:

- Merkle path: `log2(32) × 32 = 160` bytes;
- compact leaf excluding the repeated 109-byte OGP domain: approximately 128–180 bytes depending on optional one-time public key;
- merchant-bound authorization plus signature: approximately 430–560 bytes if it carries the edge fields required for standalone validation;
- root descriptor/reference: approximately 40–64 bytes;
- existing trust prefix: 924 bytes when not cached.

```text
hybrid first-contact proof:  ~1,682 to 1,888 bytes
hybrid cached-trust proof:     ~758 to   964 bytes
current depth-1 proof:                 1,398 bytes
current depth-8 proof:                 4,716 bytes
current depth-32 proof:               16,092 bytes
```

The hybrid is not guaranteed to beat the current depth-1 QR. Its advantage grows with branch depth and when the certificate/authorization are cached or exchanged once per session. The prototype must measure real canonical bytes, APDU fragmentation, retries and end-to-end latency rather than optimizing from estimates.

### Transport conclusions

- Cryptographic objects are transport-independent; the same canonical bytes must work over QR, NFC and later Bluetooth.
- QR remains the universal, inspectable fallback.
- Android HCE supports ISO-DEP/APDU communication and Android devices can act as readers, making Android-to-Android prototyping realistic.
- Apple now documents `CardSession` HCE, but use is constrained by supported use cases, geography, OS/device eligibility and managed entitlements. It cannot be assumed for an arbitrary universal phone-to-phone flow.
- No security decision may depend on NFC proximity. A nearby attacker can relay bytes; freshness comes from the merchant challenge and identity binding.

NFC decision: **GO for Android feasibility measurement after architecture prototype; NO-GO as a required cross-platform transport.**

## 14. Solana account and state impact

| Representation | Cost/scalability | Security behavior | Decision |
|---|---|---|---|
| Root only in session | Constant session state | Offline membership; no immediate spent check | Best commitment baseline |
| Session bitmap | `O(N)` bits and mutable contention | Tracks committed leaf indices after online redemption | Possible only for small fixed trees; not required initially |
| Account per note | Rent/account explosion and provisioning overhead | Direct existence/spent state | **NO-GO** |
| Claim-created nullifier record | State only for submitted notes | Atomic duplicate detection during redemption | Recommended extension if adopted |
| Session spent accumulator/root | Compact head but needs update/witness protocol | Complex concurrent proofs and availability | Deferred; not justified for prototype |

For an online merchant, checking that a nullifier record is absent is advisory: another redemption can race after the read. Strong acceptance requires submitting an atomic claim/redemption transaction and waiting for confirmation. The first confirmed transaction establishes state; later use is rejected or recorded as conflict according to the future ADR.

The isolated prototype must not modify the Anchor account layouts. Any later on-chain addition requires versioned accounts or a migration strategy and SBF/validator-backed tests.

## 15. Claim, DAG and reconciliation impact

Recommended mapping:

```text
SpendNoteLeaf + MerkleProof
        + NoteSpendAuthorization
        + referenced PaymentCredential/EconomicEdge
                       |
                       v
              existing Claim semantics
                       |
                       v
            existing StateEdgeRecord / DAG
                       |
                       v
             existing deterministic settlement
```

The note does not replace the edge. A future claim would add `note_id`, `nullifier`, `note_root`, the Merkle witness commitment and an authorization hash as evidence fields or hashes, while the economic amount comes from the validated edge.

For C1, current claim semantics can remain, but the merchant or an evidence service must retain the complete ancestor path. A design in which the merchant verifies only a note and later hopes some other party supplies missing ancestors is not self-contained and is **NO-GO** for merchant assurance.

For C2, the claim verifier must establish that the edge parent is a valid committed note parent rather than the session genesis or an earlier resulting state. The reconciler must accept a forest of certified roots (`note_parent_state_hash_i`) but can still deduplicate and sum the same edge records. This changes claim admission and DAG root validation, though not coverage allocation or settlement ordering.

Deduplication rules:

- identical edge: one economic exposure, regardless of repeated submission;
- identical note and identical edge: one exposure;
- identical note with multiple distinct valid C2 edges: same authorized parent and sequence plus different resulting hashes satisfy the formal fork predicate; every unique valid edge would remain eligible under the current all-valid-branches policy;
- different notes on the same conflicting parent/sequence: existing fork rules apply;
- invalid note proof, invalid edge or invalid signature: rejected and excluded.

Under C2, valid reuse enters `CONFLICTED` through the existing formal fork shape: same session, same note-derived parent, same note-derived sequence and different resulting state hash. A future decision is still required for any valid same-nullifier incident that does not meet that shape. Recommendation: **set the sticky incident flag and revoke offline access**, because it proves reuse of a one-use authorization, but this is deferred to an ADR and is not an MVP behavior change.

Arrival order and `created_at` remain irrelevant to eligibility and allocation.

## 16. Collateral and issuance invariants

Define:

```text
B = branch_spending_limit
A = aggregate_offline_exposure
C = collateral_coverage_cap
I = issuance_capacity = Σ denomination(note_i) over all simultaneously redeemable notes
P = total protocol payout
```

The approved invariants remain unchanged for production:

```text
for every valid linear branch b:
  Σ amount(edge in b) <= B

A = Σ amount(unique eligible EconomicEdge)

P <= min(A, C)

C = collateral_locked                    // MVP v0.1
```

The conservative C2 prototype models a forest of one-edge note branches and adds:

```text
I <= B

Σ amount(honestly consumed distinct notes) <= I <= B

for every spend authorization using note i:
  0 < amount <= denomination(note_i)

each honest note is consumed in full after one authorization
```

This does not imply `A <= I`: rollback, copying or compromised signing can reuse a note against several merchants, producing `A > I` and potentially `A > B`. `I` limits honest issuance; `C` limits protocol liability. Adopting C2 would require the `branch_spending_limit` ADR to state that the sum of all honest note-root branches is one logical spending envelope; it cannot be inferred from the current single-genesis DAG implementation.

Pre-generating notes whose denominations total 500 for a 100-unit envelope is **NO-GO** unless a reviewed construction proves that no restorable state can make more than 100 simultaneously redeemable. Convenience inventory must not silently become issuance liability.

Withdrawal safety remains unchanged:

```text
withdrawable = max(0,
  actual_protocol_accounted_collateral
  - active_session_reserves
  - frozen_unsettled_obligations)
```

No collateral reserved for an open claim window can be withdrawn merely because no note has yet appeared on-chain.

## 17. Fundamentally unsolved offline threats

1. Two fully offline merchants cannot query a shared freshness state.
2. A compromised software-signing device can authorize conflicting uses without breaking hashes or signatures.
3. General app storage can be copied or rolled back; Merkle commitments do not add monotonicity.
4. Local device time cannot prove objective order or authoritative session validity.
5. Hardware capabilities and attestation differ across vendors, OS versions and devices.
6. A malicious issuer or compromised certificate root can make merchants accept evidence that later fails protocol admission.
7. Merchants may never reconnect or submit before the deadline; the protocol cannot settle evidence it never receives.
8. Network censorship during the claim window is an availability risk.
9. Collateral bounds protocol payout, not the total nominal loss expected by all offline merchants.
10. NFC proximity does not prevent relay or establish identity by itself.

The OGP rule remains: prevent when practical, detect authenticated abuse, and bound protocol damage.

## 18. Isolated prototype plan

No prototype is authorized by this document. After explicit approval, create only `research/spend-notes/` with no imports from production applications that mutate production behavior.

### Phase P0 — canonical model

- TypeScript and Rust structs for leaf, root descriptor, proof and authorization;
- an isolated C1/C2 adapter comparison that demonstrates the ancestor-availability gap rather than assuming it away;
- explicit domain separation and fixed encodings;
- RFC-6962-style ordered Merkle implementation using vetted SHA-256 libraries;
- cross-language golden vectors;
- byte-size report for 8, 16, 32, 64 and 128 notes.

### Phase P1 — verifier and adversarial simulations

1. honest 100-unit envelope, 15-unit merchant-bound payment, offline verification and simulated claim;
2. same note to merchants A and B, duplicate evidence and bounded liability;
3. online redemption followed by immediate second rejection;
4. snapshot, spend, restore and repeat, labeling prevention versus later detection;
5. random serial plus forged proof rejection;
6. 10-to-100 value mutation rejection;
7. merchant A authorization claimed by B rejection;
8. exact replay deduplicated without double exposure;
9. copied root/note material without device key rejected;
10. overissued denomination set rejected when `I > B`.

### Phase P2 — hardware capability experiment

- Android API 31+ per-note `maxUsageCount=1` key;
- detect `FEATURE_KEYSTORE_SINGLE_USE_KEY` and actual security level;
- capture and validate attestation outside the device;
- prove second signature fails on capable hardware;
- repeat on software-only/fallback device and clearly distinguish the tier;
- measure key generation/signature latency and storage for at least 32 notes.

This phase uses P-256 and does not silently replace OGP Ed25519. Any bridge or dual-signature design is **REQUIRES CRYPTOGRAPHIC REVIEW**.

### Phase P3 — transport measurements

- encode the exact same objects over QR and Android HCE/APDUs;
- measure payload bytes, fragments, transfer time, retries and failure recovery;
- keep QR as fallback;
- do not begin production NFC integration.

### Prototype exit gate

Promotion can be considered only if measurements show a significant improvement in proof size, merchant privacy, verification simplicity or transport UX, with no unacceptable increase in rollback exposure, capital ambiguity or reconciliation complexity.

## 19. Required ADRs before any mainline adoption

1. **Spend Note object, canonical encoding and domain separation.**
2. **Merkle tree shape, root lifecycle, issuance-capacity formula and denomination policy.**
3. **Note-to-EconomicEdge binding, nullifier semantics, exact replay and conflict classification.**
4. **Certified multiple-root claim admission versus retained ancestor evidence, including merchant self-containment.**
5. **Hardware tiers, signature suites, attestation roots, revocation and fallback behavior.**
6. **Claim/account schema versioning and migration; no in-place account-size assumption.**
7. **NFC/QR transport framing, caching, privacy and relay threat.**
8. **Payer revocation semantics for valid same-note reuse.**
9. **Merchant receipt and evidence-retention obligation.**

Each ADR must identify whether it changes the original Prompt Master. No such change can be merged without explicit owner approval and an update to the source-of-truth decision log.

## 20. Final recommendation and hostile self-audit

### Recommendation

**GO:** research prototype of Architecture C, plus an optional Android hardware single-use-key experiment.  
**NO-GO:** production code, protocol schema changes, settlement changes, per-note Solana accounts, bearer-secret notes, unbounded convenience denominations, or a claim that Spend Notes solve offline double spending.  
**OPEN RISK:** cross-platform hardware single-use enforcement, iOS NFC availability, exact wire-size benefit at shallow branch depth, denomination UX, and new parser/state attack surface.

### What would invalidate the Spend Notes direction?

1. The measured cached proof is not materially smaller or faster than an optimized checkpoint/compact branch proof.
2. Exact payments require so many notes or proofs that NFC and payer UX worsen.
3. Rollback produces materially more valid merchant expectations than current edges without compensating privacy or transport benefit.
4. Hardware-enforced single use is too fragmented to define a credible higher-assurance tier.
5. Multiple authorized note roots cannot be added without making reconciliation non-deterministic, weakening merchant self-containment or changing current merchant eligibility.
6. Issuance inventory cannot be separated cleanly from protocol liability and branch limits.
7. Merchants must trust a central online authority to understand note validity, eliminating the offline-verifiable property.
8. Solana contributes no enforceable commitment, atomic redemption, immutable evidence or bounded settlement beyond what a central database provides.

### Hostile findings

| Severity | Finding | Exploitability | Affected invariant | Mitigation | Status |
|---|---|---|---|---|---|
| Critical | Merkle proof does not prove unused status | Trivial after copied state | One-use expectation | Do not claim prevention; duplicate detection, hardware tier, collateral cap | **OPEN RISK** |
| High | Restoring many independent notes may amplify fork surface | Moderate on compromised device | Honest issuance vs aggregate exposure | `I <= B`, protected storage, optional one-use keys, test rollback | **OPEN RISK** |
| High | Convenience denominations can silently overissue | Easy design error | Liability and branch limit | Enforce `issuance_capacity <= B` | Mitigated in proposed prototype |
| High | Software fallback may be mistaken for hardware single use | Common device variation | Local double-spend prevention | Capability checks, attestation, explicit assurance tier | **OPEN RISK** |
| High | New signature suite could create cross-suite confusion | Implementation-dependent | Authentication/domain separation | Algorithm ID, typed keys, ADR, cryptographic review | Deferred |
| High | Hiding the branch can leave the merchant unable to submit a self-contained claim | Inherent in C1 without retained ancestors | Claim eligibility/availability | Compare C1 retained evidence with isolated C2 multiple-root adapter | **OPEN RISK** |
| Medium | Root/session reuse creates correlation | Passive observation | Privacy | Per-session roots, selective disclosure; document leakage | Accepted for prototype |
| Medium | Online “not spent” read can race | Easy concurrency | Immediate freshness | Atomic submit-and-confirm, not read-only assurance | Mitigated by design |
| Medium | NFC relay defeats proximity assumption | Practical with equipment | Merchant intent | Challenge, explicit merchant identity, user confirmation | Partially mitigated |
| Medium | Root/account schema growth can break deployed layouts | Certain if changed carelessly | Runtime correctness | Versioned account/migration and SBF tests | Deferred |
| Low | First-payment proof may be larger than current proof | Expected | UX/performance | Cache trust prefix; measure before adoption | Open measurement |

The hostile conclusion is deliberately narrow: Spend Notes are promising as a privacy and transport optimization, not yet as an economic or double-spend-security improvement. The existing OGP architecture remains the source of truth.

---

## Sources consulted

Primary and official sources were used for claims about cryptographic and platform capabilities:

- [RFC 6962 — Merkle Tree Hash leaf/node domain separation](https://www.rfc-editor.org/rfc/rfc6962.html)
- [NIST Hash Functions — SHA-2/SHA-256](https://csrc.nist.gov/Projects/hash-functions)
- [Android Keystore and StrongBox capabilities](https://developer.android.com/privacy-and-security/keystore)
- [Android `setMaxUsageCount` and hardware single-use feature flags](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder.html#setMaxUsageCount(int))
- [Android hardware-backed key attestation](https://developer.android.com/privacy-and-security/security-key-attestation)
- [Android KeyMint rollback resistance](https://source.android.com/docs/security/features/keystore/implementer-ref#rollback-resistance)
- [Android Host Card Emulation](https://developer.android.com/develop/connectivity/nfc/hce)
- [Android backup exclusion guidance](https://developer.android.com/privacy-and-security/risks/backup-best-practices)
- [Apple Secure Enclave key constraints](https://developer.apple.com/documentation/Security/protecting-keys-with-the-secure-enclave)
- [Apple Core NFC `CardSession`](https://developer.apple.com/documentation/CoreNFC/CardSession)
- [Apple NFC & Secure Element Platform availability](https://developer.apple.com/support/nfc-se-platform/)

Repository evidence for current canonical sizes and invariants:

- `packages/canonical-codec/src/index.ts`
- `docs/protocol.md`
- `docs/architecture.md`
- `docs/threat-model.md`
- approved ADRs under `docs/adr/`

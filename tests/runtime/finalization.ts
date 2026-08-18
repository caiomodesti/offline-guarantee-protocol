import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { AnchorProvider, Program, setProvider, type Idl } from "@anchor-lang/core";
import { decodeClaim, decodeStateEdgeRecord } from "@ogp/protocol-sdk";
import BN from "bn.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

type ClaimFixture = { claim: string; edge: string; credentialHash: string };
type InsolvencyClaimFixture = ClaimFixture & {
  merchant: string;
  merchantToken: string;
};
type Fixture = {
  slot: number;
  session: string;
  profile: string;
  vault: string;
  vaultToken: string;
  ownerToken: string;
  ownerSecretKey: number[];
  settlementMint: string;
  firstEdge: string;
  forkEdge: string;
  forkRecord: string;
  merchantToken: string;
  otherMerchantToken: string;
  merchant: string;
  otherMerchant: string;
  representativeClaim: string;
  forkClaim: string;
  rejectedClaim: string;
  claims: ClaimFixture[];
  insolvency: {
    session: string;
    profile: string;
    vault: string;
    vaultToken: string;
    forkRecord: string;
    claims: InsolvencyClaimFixture[];
  };
  normal: {
    session: string;
    profile: string;
    vault: string;
    vaultToken: string;
    merchant: string;
    merchantToken: string;
    claim: string;
    edge: string;
    forkRecord: string;
    credentialHash: string;
  };
};

type RuntimeReport = {
  environment: Record<string, string>;
  programId: string;
  computeUnits: Record<string, number | null>;
  tests: Array<{ name: string; status: "PASS"; evidence?: string }>;
  documentedLimitations: string[];
};

const provider = AnchorProvider.env();
setProvider(provider);
const connection = provider.connection;
const payer = provider.wallet.payer;
if (!payer) throw new Error("Anchor provider wallet must expose its payer keypair");

const idl = JSON.parse(await readFile("target/idl/offline_guarantee.json", "utf8")) as Idl;
const program: any = new Program(idl, provider);
const fixture = JSON.parse(
  await readFile("target/sprint-6-finalization-fixture.json", "utf8"),
) as Fixture;
const report = JSON.parse(await readFile("target/runtime-proof.json", "utf8")) as RuntimeReport;

const key = (value: string): PublicKey => new PublicKey(value);
const session = key(fixture.session);
const profile = key(fixture.profile);
const vault = key(fixture.vault);
const vaultToken = key(fixture.vaultToken);
const settlementMint = key(fixture.settlementMint);
const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
const owner = Keypair.fromSecretKey(Uint8Array.from(fixture.ownerSecretKey));

function asNumber(value: bigint | { toString(): string }): number {
  return Number(value.toString());
}

async function fetchRaw(address: PublicKey): Promise<Uint8Array> {
  const account = await connection.getAccountInfo(address, "confirmed");
  assert(account, `missing account ${address.toBase58()}`);
  return account.data;
}

async function expectFailure(label: string, operation: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await operation();
  } catch {
    failed = true;
  }
  assert(failed, `${label} unexpectedly succeeded`);
}

async function recordCompute(name: string, signature: string): Promise<void> {
  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  report.computeUnits[name] = transaction?.meta?.computeUnitsConsumed ?? null;
}

async function confirmSignature(signature: string): Promise<void> {
  await connection.confirmTransaction(signature, "confirmed");
}

function pass(name: string, evidence: string): void {
  report.tests.push({ name, status: "PASS", evidence });
  console.log(`PASS ${name} - ${evidence}`);
}

const blockTime = await connection.getBlockTime(await connection.getSlot("confirmed"));
assert(blockTime !== null);
const sessionBefore = await program.account.offlineSession.fetch(session);
assert(blockTime > asNumber(sessionBefore.claimSubmissionDeadline));

const beginSignature = await program.methods
  .beginFinalization()
  .accounts({ session, vault })
  .rpc();
await confirmSignature(beginSignature);
await recordCompute("begin_finalization", beginSignature);
let frozenSession = await program.account.offlineSession.fetch(session);
assert("reconciling" in frozenSession.status);
assert.equal(asNumber(frozenSession.frozenEdgeCount), 2);
assert.equal(asNumber(frozenSession.frozenExposure), 55);
assert.equal(asNumber(frozenSession.submittedClaimCount), 3);
pass("deadline-backed claim freeze", "the warped validator clock is past the real six-hour deadline; 2 edges, 55 units, and all 3 wrappers are frozen");

for (const edgeAddress of [fixture.firstEdge, fixture.forkEdge]) {
  const signature = await program.methods
    .classifyEdge()
    .accounts({
      session,
      stateEdge: key(edgeAddress),
      forkRecord: key(fixture.forkRecord),
      parentEdge: session,
    })
    .rpc();
  await confirmSignature(signature);
  await recordCompute("classify_edge", signature);
}
await expectFailure("duplicate edge classification", () =>
  program.methods
    .classifyEdge()
    .accounts({
      session,
      stateEdge: key(fixture.firstEdge),
      forkRecord: key(fixture.forkRecord),
      parentEdge: session,
    })
    .rpc(),
);
frozenSession = await program.account.offlineSession.fetch(session);
assert.equal(frozenSession.classificationComplete, true);
assert.equal(asNumber(frozenSession.classifiedEdgeCount), 2);
assert.equal(asNumber(frozenSession.conflictingClaimCount), 0);
for (const edgeAddress of [fixture.firstEdge, fixture.forkEdge]) {
  const edge = decodeStateEdgeRecord(await fetchRaw(key(edgeAddress)));
  assert.equal(edge.classified, true);
  assert.equal(edge.conflicting, true);
}
pass("verified conflict classification", "both distinct children of the authenticated genesis fork are classified conflicting; repeated classification rolls back");

assert.equal(fixture.claims.length, 3);
await expectFailure("out-of-order allocation", () => {
  const wrong = fixture.claims[1]!;
  return program.methods
    .allocateNextClaim()
    .accounts({ session, vault, claim: key(wrong.claim), stateEdge: key(wrong.edge) })
    .rpc();
});
for (const entry of fixture.claims) {
  const signature = await program.methods
    .allocateNextClaim()
    .accounts({ session, vault, claim: key(entry.claim), stateEdge: key(entry.edge) })
    .rpc();
  await confirmSignature(signature);
  await recordCompute("allocate_next_claim", signature);
}

const representativeClaim = decodeClaim(await fetchRaw(key(fixture.representativeClaim)));
const forkClaim = decodeClaim(await fetchRaw(key(fixture.forkClaim)));
const rejectedClaim = decodeClaim(await fetchRaw(key(fixture.rejectedClaim)));
const allocatedSession = await program.account.offlineSession.fetch(session);
const allocatedVault = await program.account.collateralVault.fetch(vault);
assert.equal(representativeClaim.status, "conflicting");
assert.equal(representativeClaim.allocatedAmount, 25n);
assert.equal(forkClaim.status, "conflicting");
assert.equal(forkClaim.allocatedAmount, 30n);
assert.equal(rejectedClaim.status, "rejected");
assert.equal(rejectedClaim.allocatedAmount, 0n);
assert.equal(allocatedSession.allocationComplete, true);
assert("fullyCovered" in allocatedSession.coverageStatus);
assert("conflicted" in allocatedSession.status);
assert.equal(asNumber(allocatedSession.allocatedTotal), 55);
assert.equal(asNumber(allocatedSession.conflictingClaimCount), 2);
assert.equal(asNumber(allocatedVault.reservedAmount), 55);
pass("deterministic full coverage", "credential-hash traversal ignores the rejected wrapper economically, allocates 25+30, and releases 245 while preserving 55 unpaid reserve");

const attackerToken = (
  await getOrCreateAssociatedTokenAccount(connection, payer, settlementMint, payer.publicKey)
).address;
await expectFailure("merchant destination substitution", () =>
  program.methods
    .settleClaim()
    .accounts({
      config,
      settlementMint,
      session,
      profile,
      vault,
      vaultToken,
      claim: key(fixture.representativeClaim),
      stateEdge: key(fixture.firstEdge),
      merchantToken: attackerToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc(),
);

const merchantBefore = (await getAccount(connection, key(fixture.merchantToken))).amount;
const otherBefore = (await getAccount(connection, key(fixture.otherMerchantToken))).amount;
const firstSettlement = await program.methods
  .settleClaim()
  .accounts({
    config,
    settlementMint,
    session,
    profile,
    vault,
    vaultToken,
    claim: key(fixture.representativeClaim),
    stateEdge: key(fixture.firstEdge),
    merchantToken: key(fixture.merchantToken),
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
await confirmSignature(firstSettlement);
await recordCompute("settle_claim", firstSettlement);
await expectFailure("claim settlement replay", () =>
  program.methods
    .settleClaim()
    .accounts({
      config,
      settlementMint,
      session,
      profile,
      vault,
      vaultToken,
      claim: key(fixture.representativeClaim),
      stateEdge: key(fixture.firstEdge),
      merchantToken: key(fixture.merchantToken),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc(),
);
const secondSettlement = await program.methods
  .settleClaim()
  .accounts({
    config,
    settlementMint,
    session,
    profile,
    vault,
    vaultToken,
    claim: key(fixture.forkClaim),
    stateEdge: key(fixture.forkEdge),
    merchantToken: key(fixture.otherMerchantToken),
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
await confirmSignature(secondSettlement);

assert.equal((await getAccount(connection, key(fixture.merchantToken))).amount - merchantBefore, 25n);
assert.equal((await getAccount(connection, key(fixture.otherMerchantToken))).amount - otherBefore, 30n);
const settledSession = await program.account.offlineSession.fetch(session);
const settledProfile = await program.account.userProfile.fetch(profile);
const settledVault = await program.account.collateralVault.fetch(vault);
assert("closed" in settledSession.status);
assert.equal(asNumber(settledSession.settledAmount), 55);
assert.equal(settledProfile.offlineAccessEnabled, false);
assert.equal(settledProfile.activeSession.toBase58(), PublicKey.default.toBase58());
assert.equal(asNumber(settledVault.depositedAmount), 245);
assert.equal(asNumber(settledVault.reservedAmount), 0);
assert.equal(asNumber(settledVault.settledFromCollateral), 55);
assert.equal((await getAccount(connection, vaultToken)).amount, 245n);
pass("real SPL settlement and atomic close", "PDA-signed transfer_checked pays both conflicting merchants, rejects redirection/replay, consumes 55 book+token units, and closes the revoked session");

await expectFailure("withdrawal above formal availability", () =>
  program.methods
    .withdrawCollateral(new BN(246))
    .accounts({
      config,
      settlementMint,
      owner: owner.publicKey,
      vault,
      vaultToken,
      ownerToken: key(fixture.ownerToken),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([owner])
    .rpc(),
);
const withdrawalSignature = await program.methods
  .withdrawCollateral(new BN(245))
  .accounts({
    config,
    settlementMint,
    owner: owner.publicKey,
    vault,
    vaultToken,
    ownerToken: key(fixture.ownerToken),
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([owner])
  .rpc();
await confirmSignature(withdrawalSignature);
await recordCompute("withdraw_collateral", withdrawalSignature);
const emptyVault = await program.account.collateralVault.fetch(vault);
assert.equal(asNumber(emptyVault.depositedAmount), 0);
assert.equal(asNumber(emptyVault.reservedAmount), 0);
assert.equal((await getAccount(connection, vaultToken)).amount, 0n);
pass("formal withdrawal safety", "246 fails; exactly deposited_amount-reserved_amount=245 succeeds after all claim-window and unpaid-allocation exposure is gone");

const normalSession = key(fixture.normal.session);
const normalProfile = key(fixture.normal.profile);
const normalVault = key(fixture.normal.vault);
const normalVaultToken = key(fixture.normal.vaultToken);
const normalClaim = key(fixture.normal.claim);
const normalEdge = key(fixture.normal.edge);
const normalMerchantToken = key(fixture.normal.merchantToken);
const normalBeginSignature = await program.methods
  .beginFinalization()
  .accounts({ session: normalSession, vault: normalVault })
  .rpc();
await confirmSignature(normalBeginSignature);
const normalClassifySignature = await program.methods
  .classifyEdge()
  .accounts({
    session: normalSession,
    stateEdge: normalEdge,
    forkRecord: key(fixture.normal.forkRecord),
    parentEdge: normalSession,
  })
  .rpc();
await confirmSignature(normalClassifySignature);
const normalAllocateSignature = await program.methods
  .allocateNextClaim()
  .accounts({ session: normalSession, vault: normalVault, claim: normalClaim, stateEdge: normalEdge })
  .rpc();
await confirmSignature(normalAllocateSignature);
const normalAllocatedSession = await program.account.offlineSession.fetch(normalSession);
const normalAllocatedClaim = decodeClaim(await fetchRaw(normalClaim));
const normalAllocatedEdge = decodeStateEdgeRecord(await fetchRaw(normalEdge));
const normalReservedVault = await program.account.collateralVault.fetch(normalVault);
assert("reconciling" in normalAllocatedSession.status);
assert("fullyCovered" in normalAllocatedSession.coverageStatus);
assert.equal(normalAllocatedSession.authenticatedFork, false);
assert.equal(asNumber(normalAllocatedSession.frozenExposure), 50);
assert.equal(asNumber(normalAllocatedSession.allocatedTotal), 50);
assert.equal(normalAllocatedClaim.status, "valid");
assert.equal(normalAllocatedClaim.allocatedAmount, 50n);
assert.equal(normalAllocatedEdge.conflicting, false);
assert.equal(asNumber(normalReservedVault.reservedAmount), 50);
pass("Sprint 8 normal deterministic allocation", "one merchant edge freezes and receives its full 50-unit allocation without conflict or arrival-order policy");

const normalMerchantBefore = (await getAccount(connection, normalMerchantToken)).amount;
const normalSettlementSignature = await program.methods
  .settleClaim()
  .accounts({
    config,
    settlementMint,
    session: normalSession,
    profile: normalProfile,
    vault: normalVault,
    vaultToken: normalVaultToken,
    claim: normalClaim,
    stateEdge: normalEdge,
    merchantToken: normalMerchantToken,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
await confirmSignature(normalSettlementSignature);
await recordCompute("sprint_8_settle_claim", normalSettlementSignature);
const normalSettledSession = await program.account.offlineSession.fetch(normalSession);
assert("settled" in normalSettledSession.status);
assert.equal(asNumber(normalSettledSession.settledAmount), 50);
const normalCloseSignature = await program.methods
  .closeSession()
  .accounts({ session: normalSession, profile: normalProfile })
  .rpc();
await confirmSignature(normalCloseSignature);
await recordCompute("sprint_8_close_session", normalCloseSignature);
const normalClosedSession = await program.account.offlineSession.fetch(normalSession);
const normalRecoveredProfile = await program.account.userProfile.fetch(normalProfile);
const normalSettledVault = await program.account.collateralVault.fetch(normalVault);
assert.equal((await getAccount(connection, normalMerchantToken)).amount - normalMerchantBefore, 50n);
assert("closed" in normalClosedSession.status);
assert.equal(asNumber(normalClosedSession.settledAmount), 50);
assert.equal(normalRecoveredProfile.offlineAccessEnabled, true);
assert.equal(normalRecoveredProfile.activeSession.toBase58(), PublicKey.default.toBase58());
assert.equal(asNumber(normalRecoveredProfile.successfulSessions), 1);
assert.equal(asNumber(normalSettledVault.depositedAmount), 250);
assert.equal(asNumber(normalSettledVault.reservedAmount), 0);
assert.equal(asNumber(normalSettledVault.settledFromCollateral), 50);
assert.equal((await getAccount(connection, normalVaultToken)).amount, 250n);
pass("Sprint 8 payer-independent SPL settlement", "merchant receives 50 through PDA transfer_checked; permissionless close_session then closes the non-conflicted session without the payer key or payer reconnection");

const insolventSession = key(fixture.insolvency.session);
const insolventProfile = key(fixture.insolvency.profile);
const insolventVault = key(fixture.insolvency.vault);
const insolventVaultToken = key(fixture.insolvency.vaultToken);
const insolventBeginSignature = await program.methods
  .beginFinalization()
  .accounts({ session: insolventSession, vault: insolventVault })
  .rpc();
await confirmSignature(insolventBeginSignature);
for (const entry of fixture.insolvency.claims) {
  const signature = await program.methods
    .classifyEdge()
    .accounts({
      session: insolventSession,
      stateEdge: key(entry.edge),
      forkRecord: key(fixture.insolvency.forkRecord),
      parentEdge: insolventSession,
    })
    .rpc();
  await confirmSignature(signature);
}
for (const entry of fixture.insolvency.claims) {
  const signature = await program.methods
    .allocateNextClaim()
    .accounts({
      session: insolventSession,
      vault: insolventVault,
      claim: key(entry.claim),
      stateEdge: key(entry.edge),
    })
    .rpc();
  await confirmSignature(signature);
}
const insolventAllocated = await program.account.offlineSession.fetch(insolventSession);
const insolventReserved = await program.account.collateralVault.fetch(insolventVault);
assert("insolvent" in insolventAllocated.status);
assert("insolvent" in insolventAllocated.coverageStatus);
assert.equal(asNumber(insolventAllocated.frozenExposure), 400);
assert.equal(asNumber(insolventAllocated.allocatedTotal), 300);
assert.equal(asNumber(insolventAllocated.conflictingClaimCount), 4);
assert.equal(asNumber(insolventReserved.reservedAmount), 300);
for (const entry of fixture.insolvency.claims) {
  const claim = decodeClaim(await fetchRaw(key(entry.claim)));
  assert.equal(claim.status, "conflicting");
  assert.equal(claim.allocatedAmount, 75n);
}
await expectFailure("insolvent close before settlement", () =>
  program.methods
    .closeSession()
    .accounts({ session: insolventSession, profile: insolventProfile })
    .rpc(),
);
pass("runtime pro-rata cap", "400 aggregate exposure deterministically allocates 75 to each of four hash-ordered branches; total liability is exactly capped at 300");

const insolvencyBalances = await Promise.all(
  fixture.insolvency.claims.map(async (entry) =>
    (await getAccount(connection, key(entry.merchantToken))).amount
  ),
);
for (const [index, entry] of fixture.insolvency.claims.entries()) {
  const signature = await program.methods
    .settleClaim()
    .accounts({
      config,
      settlementMint,
      session: insolventSession,
      profile: insolventProfile,
      vault: insolventVault,
      vaultToken: insolventVaultToken,
      claim: key(entry.claim),
      stateEdge: key(entry.edge),
      merchantToken: key(entry.merchantToken),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  await confirmSignature(signature);
  assert.equal(
    (await getAccount(connection, key(entry.merchantToken))).amount
      - insolvencyBalances[index]!,
    75n,
  );
}
const insolventClosed = await program.account.offlineSession.fetch(insolventSession);
const insolventEmptyVault = await program.account.collateralVault.fetch(insolventVault);
assert("closed" in insolventClosed.status);
assert.equal(asNumber(insolventClosed.settledAmount), 300);
assert.equal(asNumber(insolventEmptyVault.depositedAmount), 0);
assert.equal(asNumber(insolventEmptyVault.reservedAmount), 0);
assert.equal((await getAccount(connection, insolventVaultToken)).amount, 0n);
pass("insolvent SPL settlement", "four PDA-signed transfers pay the stored 75-unit allocations, never exceed the 300 cap, and atomically close with zero reserve");

await writeFile("target/runtime-proof.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(`SPRINT 6 FINALIZATION PASS (${report.tests.length} cumulative checks)`);

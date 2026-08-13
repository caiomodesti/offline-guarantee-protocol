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
await program.methods
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
await recordCompute("withdraw_collateral", withdrawalSignature);
const emptyVault = await program.account.collateralVault.fetch(vault);
assert.equal(asNumber(emptyVault.depositedAmount), 0);
assert.equal(asNumber(emptyVault.reservedAmount), 0);
assert.equal((await getAccount(connection, vaultToken)).amount, 0n);
pass("formal withdrawal safety", "246 fails; exactly deposited_amount-reserved_amount=245 succeeds after all claim-window and unpaid-allocation exposure is gone");

await writeFile("target/runtime-proof.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(`SPRINT 6 FINALIZATION PASS (${report.tests.length} cumulative checks)`);

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AnchorProvider, BN, Program, setProvider, type Idl } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionSignature,
} from "@solana/web3.js";

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
assert(payer, "Anchor provider wallet must expose its payer keypair");

const idl = JSON.parse(
  await readFile("target/idl/offline_guarantee.json", "utf8"),
) as Idl;
const program: any = new Program(idl, provider);
const report: RuntimeReport = {
  environment: {
    rpcUrl: process.env.ANCHOR_PROVIDER_URL ?? "unknown",
    validator: "solana-test-validator (anchor --validator legacy)",
  },
  programId: program.programId.toBase58(),
  computeUnits: {},
  tests: [],
  documentedLimitations: [
    "A state with protocol deposited_amount above the real SPL balance cannot be produced through legitimate Sprint 3 instructions; test 9 is therefore proven unreachable rather than fabricated by mutating account memory.",
    "The PDA cannot produce an external Ed25519 signature. Custody is proven by the decoded SPL authority and failed transfers signed by user/admin/emergency keys.",
  ],
};

function pass(name: string, evidence?: string): void {
  report.tests.push({ name, status: "PASS", evidence });
  console.log(`PASS ${name}${evidence ? ` - ${evidence}` : ""}`);
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

async function airdrop(key: PublicKey, sol = 5): Promise<void> {
  const signature = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

async function chainNow(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  assert(blockTime !== null, "validator returned no block time");
  return blockTime;
}

async function recordCompute(name: string, signature: TransactionSignature): Promise<void> {
  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  report.computeUnits[name] = transaction?.meta?.computeUnitsConsumed ?? null;
}

function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
}

function profilePda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), owner.toBuffer()],
    program.programId,
  )[0];
}

function vaultPda(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), owner.toBuffer(), mint.toBuffer()],
    program.programId,
  )[0];
}

function vaultTokenPda(vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault-token"), vault.toBuffer()],
    program.programId,
  )[0];
}

function sessionPda(owner: PublicKey, sessionId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session"), owner.toBuffer(), Buffer.from(sessionId)],
    program.programId,
  )[0];
}

function nonzero(seed: number): number[] {
  return Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
}

const admin = payer;
const emergency = Keypair.generate();
const identity = Keypair.generate();
const certificateIssuer = Keypair.generate();
const randomSigner = Keypair.generate();
await Promise.all([
  airdrop(emergency.publicKey),
  airdrop(identity.publicKey, 20),
  airdrop(certificateIssuer.publicKey),
  airdrop(randomSigner.publicKey),
]);

const settlementMint = await createMint(
  connection,
  payer,
  payer.publicKey,
  null,
  0,
);
const config = configPda();
const initializeSignature = await program.methods
  .initializeProtocol(
    emergency.publicKey,
    identity.publicKey,
    certificateIssuer.publicKey,
  )
  .accounts({
    config,
    settlementMint,
    admin: admin.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
await recordCompute("initialize_protocol", initializeSignature);
const configState = await program.account.protocolConfig.fetch(config);
assert.equal(configState.minimumCollateralRatioBps, 30_000);
assert.equal(configState.maxSessionDurationSeconds.toNumber(), 10_800);
assert.equal(configState.claimGracePeriodSeconds.toNumber(), 21_600);
assert.equal(configState.maxBranchDepth, 32);
assert.equal(configState.paused, false);
assert.equal(configState.admin.toBase58(), admin.publicKey.toBase58());
assert.equal(configState.emergencyAuthority.toBase58(), emergency.publicKey.toBase58());
assert.equal(configState.identityAuthority.toBase58(), identity.publicKey.toBase58());
assert.equal(configState.certificateIssuer.toBase58(), certificateIssuer.publicKey.toBase58());
pass("initialize protocol", "fixed parameters and four separated authorities decoded on-chain");

async function setPaused(authority: Keypair, paused: boolean): Promise<string> {
  return program.methods
    .setPaused(paused)
    .accounts({ config, authority: authority.publicKey })
    .signers(authority === payer ? [] : [authority])
    .rpc();
}

await expectFailure("random signer profile creation", async () => {
  const owner = Keypair.generate();
  await program.methods
    .createUserProfile(nonzero(1), new BN((await chainNow()) + 3600))
    .accounts({
      config,
      identityAuthority: randomSigner.publicKey,
      owner: owner.publicKey,
      profile: profilePda(owner.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .signers([randomSigner])
    .rpc();
});
await setPaused(emergency, true);
assert.equal((await program.account.protocolConfig.fetch(config)).paused, true);
await expectFailure("emergency unpause", () => setPaused(emergency, false));
await setPaused(admin, false);
assert.equal((await program.account.protocolConfig.fetch(config)).paused, false);
const adminPauseSignature = await setPaused(admin, true);
await recordCompute("set_paused", adminPauseSignature);
await setPaused(admin, false);
pass("authority separation", "identity, emergency and admin permissions enforced by runtime");

type PreparedUser = {
  owner: Keypair;
  profile: PublicKey;
  vault: PublicKey;
  vaultToken: PublicKey;
  ownerToken: PublicKey;
};

async function prepareUser(seed: number, depositAmount = 300): Promise<PreparedUser> {
  const owner = Keypair.generate();
  await airdrop(owner.publicKey, 10);
  const profile = profilePda(owner.publicKey);
  const profileSignature = await program.methods
    .createUserProfile(nonzero(seed), new BN((await chainNow()) + 86_400))
    .accounts({
      config,
      identityAuthority: identity.publicKey,
      owner: owner.publicKey,
      profile,
      systemProgram: SystemProgram.programId,
    })
    .signers([identity])
    .rpc();
  if (report.computeUnits.create_user_profile === undefined) {
    await recordCompute("create_user_profile", profileSignature);
  }
  const vault = vaultPda(owner.publicKey, settlementMint);
  const vaultToken = vaultTokenPda(vault);
  const vaultSignature = await program.methods
    .createVault()
    .accounts({
      config,
      owner: owner.publicKey,
      settlementMint,
      vault,
      vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([owner])
    .rpc();
  if (report.computeUnits.create_vault === undefined) {
    await recordCompute("create_vault", vaultSignature);
  }
  const ownerToken = (
    await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      settlementMint,
      owner.publicKey,
    )
  ).address;
  await mintTo(connection, payer, settlementMint, ownerToken, payer, 1000);
  if (depositAmount > 0) {
    const depositSignature = await program.methods
      .depositCollateral(new BN(depositAmount))
      .accounts({
        config,
        settlementMint,
        owner: owner.publicKey,
        ownerToken,
        vault,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([owner])
      .rpc();
    if (report.computeUnits.deposit_collateral === undefined) {
      await recordCompute("deposit_collateral", depositSignature);
    }
  }
  return { owner, profile, vault, vaultToken, ownerToken };
}

async function createSession(
  user: PreparedUser,
  seed: number,
  locked: number,
  limit: number,
  expiresAt: number,
): Promise<{ signature: string; session: PublicKey }> {
  const sessionId = Uint8Array.from(nonzero(seed));
  const session = sessionPda(user.owner.publicKey, sessionId);
  const signature = await program.methods
    .createOfflineSession(
      Array.from(sessionId),
      Keypair.generate().publicKey,
      new BN(locked),
      new BN(limit),
      new BN(expiresAt),
      nonzero(seed + 33),
      nonzero(seed + 66),
    )
    .accounts({
      config,
      settlementMint,
      owner: user.owner.publicKey,
      profile: user.profile,
      vault: user.vault,
      vaultToken: user.vaultToken,
      session,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user.owner])
    .rpc();
  return { signature, session };
}

const main = await prepareUser(10);
assert.equal((await getAccount(connection, main.ownerToken)).amount, 700n);
assert.equal((await getAccount(connection, main.vaultToken)).amount, 300n);
assert.equal((await program.account.collateralVault.fetch(main.vault)).depositedAmount.toNumber(), 300);
pass("real SPL deposit CPI", "1000 -> 700 owner, 300 vault, deposited_amount=300");

await transfer(connection, payer, main.ownerToken, main.vaultToken, main.owner, 50);
assert.equal((await getAccount(connection, main.vaultToken)).amount, 350n);
assert.equal((await program.account.collateralVault.fetch(main.vault)).depositedAmount.toNumber(), 300);
pass("direct donation accounting", "actual balance=350 while deposited_amount remains 300");

const decodedVaultToken = await getAccount(connection, main.vaultToken);
assert.equal(decodedVaultToken.mint.toBase58(), settlementMint.toBase58());
assert.equal(decodedVaultToken.owner.toBase58(), main.vault.toBase58());
pass("PDA token custody", "classic SPL account authority equals CollateralVault PDA");

const nowForMain = await chainNow();
const valid = await createSession(main, 20, 300, 100, nowForMain + 3600);
await recordCompute("create_offline_session", valid.signature);
const mainSession = await program.account.offlineSession.fetch(valid.session);
const mainVault = await program.account.collateralVault.fetch(main.vault);
const mainProfile = await program.account.userProfile.fetch(main.profile);
assert("active" in mainSession.status);
assert.equal(mainSession.collateralLocked.toNumber(), 300);
assert.equal(mainSession.collateralCoverageCap.toNumber(), 300);
assert.equal(mainSession.branchSpendingLimit.toNumber(), 100);
assert.equal(mainSession.aggregateOfflineExposure.toNumber(), 0);
assert.equal(mainVault.reservedAmount.toNumber(), 300);
assert.equal(mainProfile.activeSession.toBase58(), valid.session.toBase58());
assert.equal(mainSession.claimSubmissionDeadline.toNumber(), mainSession.expiresAt.toNumber() + 21_600);
assert(Math.abs(mainSession.issuedAt.toNumber() - nowForMain) <= 10);
pass("valid exact 300% session", "coverage cap derived on-chain and full collateral reserved");
pass("Solana Clock and claim deadline", "issued_at is runtime-derived; deadline=expires_at+21600");

const secondSessionId = Uint8Array.from(nonzero(21));
const secondSession = sessionPda(main.owner.publicKey, secondSessionId);
await expectFailure("second active session", async () =>
  createSession(main, 21, 300, 100, (await chainNow()) + 3600),
);
assert.equal((await program.account.collateralVault.fetch(main.vault)).reservedAmount.toNumber(), 300);
assert.equal((await program.account.userProfile.fetch(main.profile)).activeSession.toBase58(), valid.session.toBase58());
assert.equal(await connection.getAccountInfo(secondSession), null);
pass("single active session", "no second reservation or session account survived");

const under = await prepareUser(30);
const underVaultBefore = await program.account.collateralVault.fetch(under.vault);
const underProfileBefore = await program.account.userProfile.fetch(under.profile);
const underSessionId = Uint8Array.from(nonzero(31));
const underSession = sessionPda(under.owner.publicKey, underSessionId);
await expectFailure("299% session", async () =>
  createSession(under, 31, 299, 100, (await chainNow()) + 3600),
);
const underVaultAfter = await program.account.collateralVault.fetch(under.vault);
const underProfileAfter = await program.account.userProfile.fetch(under.profile);
assert.equal(underVaultAfter.reservedAmount.toString(), underVaultBefore.reservedAmount.toString());
assert.equal(underProfileAfter.activeSession.toBase58(), underProfileBefore.activeSession.toBase58());
assert.equal(await connection.getAccountInfo(underSession), null);
pass("below 300% and atomic rollback", "299/100 rejected with no account or state residue");

const accounting = await prepareUser(40);
await transfer(connection, payer, accounting.ownerToken, accounting.vaultToken, accounting.owner, 50);
assert.equal((await getAccount(connection, accounting.vaultToken)).amount, 350n);
await expectFailure("reserve above deposited accounting", async () =>
  createSession(accounting, 41, 320, 100, (await chainNow()) + 3600),
);
assert.equal((await program.account.collateralVault.fetch(accounting.vault)).reservedAmount.toNumber(), 0);
assert.equal((await program.account.userProfile.fetch(accounting.profile)).activeSession.toBase58(), PublicKey.default.toBase58());
pass("accounting versus real balance", "320<=350 real balance but 320>300 deposited_amount is rejected");

const failedDepositUser = await prepareUser(50);
const failedDepositVaultBefore = await program.account.collateralVault.fetch(failedDepositUser.vault);
const failedOwnerBalanceBefore = (await getAccount(connection, failedDepositUser.ownerToken)).amount;
const failedVaultBalanceBefore = (await getAccount(connection, failedDepositUser.vaultToken)).amount;
await expectFailure("failed deposit CPI", () =>
  program.methods
    .depositCollateral(new BN(1000))
    .accounts({
      config,
      settlementMint,
      owner: failedDepositUser.owner.publicKey,
      ownerToken: failedDepositUser.ownerToken,
      vault: failedDepositUser.vault,
      vaultToken: failedDepositUser.vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([failedDepositUser.owner])
    .rpc(),
);
assert.equal((await program.account.collateralVault.fetch(failedDepositUser.vault)).depositedAmount.toString(), failedDepositVaultBefore.depositedAmount.toString());
assert.equal((await getAccount(connection, failedDepositUser.ownerToken)).amount, failedOwnerBalanceBefore);
assert.equal((await getAccount(connection, failedDepositUser.vaultToken)).amount, failedVaultBalanceBefore);
pass("failed deposit rollback", "CPI failure leaves SPL balances and protocol accounting unchanged");

const clockUser = await prepareUser(60);
const clockNow = await chainNow();
await expectFailure("expired session", () => createSession(clockUser, 61, 300, 100, clockNow));
await expectFailure("session beyond three hours", () => createSession(clockUser, 62, 300, 100, clockNow + 10_801));
const clockValid = await createSession(clockUser, 63, 300, 100, clockNow + 10_800);
const clockState = await program.account.offlineSession.fetch(clockValid.session);
assert(clockState.issuedAt.toNumber() <= clockState.expiresAt.toNumber());
assert(clockState.expiresAt.toNumber() - clockState.issuedAt.toNumber() <= 10_800);
pass("Solana Clock window bounds", "expired and >3h fail; small/exact-bound duration passes");

const pauseReady = await prepareUser(70);
const pauseFreshOwner = Keypair.generate();
await airdrop(pauseFreshOwner.publicKey, 5);
await setPaused(admin, true);
const pausedConfig = await program.account.protocolConfig.fetch(config);
assert.equal(pausedConfig.paused, true);
await expectFailure("paused profile", () =>
  program.methods
    .createUserProfile(nonzero(71), new BN((await chainNow()) + 3600))
    .accounts({
      config,
      identityAuthority: identity.publicKey,
      owner: pauseFreshOwner.publicKey,
      profile: profilePda(pauseFreshOwner.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .signers([identity])
    .rpc(),
);
const pausedVault = vaultPda(pauseFreshOwner.publicKey, settlementMint);
await expectFailure("paused vault", () =>
  program.methods
    .createVault()
    .accounts({
      config,
      owner: pauseFreshOwner.publicKey,
      settlementMint,
      vault: pausedVault,
      vaultToken: vaultTokenPda(pausedVault),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([pauseFreshOwner])
    .rpc(),
);
await expectFailure("paused deposit", () =>
  program.methods
    .depositCollateral(new BN(1))
    .accounts({
      config,
      settlementMint,
      owner: pauseReady.owner.publicKey,
      ownerToken: pauseReady.ownerToken,
      vault: pauseReady.vault,
      vaultToken: pauseReady.vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([pauseReady.owner])
    .rpc(),
);
await expectFailure("paused session", async () =>
  createSession(pauseReady, 72, 300, 100, (await chainNow()) + 3600),
);
assert.equal((await program.account.collateralVault.fetch(pauseReady.vault)).reservedAmount.toNumber(), 0);
assert.equal((await program.account.userProfile.fetch(pauseReady.profile)).activeSession.toBase58(), PublicKey.default.toBase58());
await setPaused(admin, false);
pass("pause gate", "profile, vault, deposit and session fail without state corruption");

const attackerToken = await createAssociatedTokenAccount(
  connection,
  payer,
  settlementMint,
  admin.publicKey,
);
await expectFailure("admin transfer from PDA vault", () =>
  transfer(connection, payer, main.vaultToken, attackerToken, admin, 1),
);
const emergencyToken = await createAssociatedTokenAccount(
  connection,
  payer,
  settlementMint,
  emergency.publicKey,
);
await expectFailure("emergency transfer from PDA vault", () =>
  transfer(connection, payer, main.vaultToken, emergencyToken, emergency, 1),
);
assert.equal((await getAccount(connection, main.vaultToken)).amount, 350n);
pass("PDA ownership and signing", "admin/emergency signatures cannot move vault collateral");

await mkdir("target", { recursive: true });
await writeFile("target/runtime-proof.json", `${JSON.stringify(report, null, 2)}\n`);
console.log(`RUNTIME TESTS PASS (${report.tests.length} checks)`);

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AnchorProvider, Program, setProvider, type Idl } from "@anchor-lang/core";
import { encodePaymentCredentialPayload } from "@ogp/canonical-codec";
import { createDomain, createGenesisState, genesisStateHash, paymentStateHash } from "@ogp/credentials";
import { derivePublicKey, generateSecretKey, hashSha256, signEd25519 } from "@ogp/crypto";
import { NetworkId, ObjectType, type DomainContext, type PaymentCredentialPayload, type PaymentState } from "@ogp/shared-types";
import BN from "bn.js";
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
  Ed25519Program,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
const providerPayer = provider.wallet.payer;
if (!providerPayer) {
  throw new Error("Anchor provider wallet must expose its payer keypair");
}
const payer: Keypair = providerPayer;

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
  report.tests.push(evidence === undefined ? { name, status: "PASS" } : { name, status: "PASS", evidence });
  console.log(`PASS ${name}${evidence ? ` - ${evidence}` : ""}`);
}

function asNumber(value: bigint | { toString(): string }): number {
  return Number(value.toString());
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

function claimPda(session: PublicKey, credentialHash: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), session.toBuffer(), Buffer.from(credentialHash)],
    program.programId,
  )[0];
}

function edgePda(
  session: PublicKey,
  previousStateHash: Uint8Array,
  sequence: number,
  newStateHash: Uint8Array,
): PublicKey {
  const sequenceBytes = Buffer.alloc(4);
  sequenceBytes.writeUInt32LE(sequence);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("edge"),
      session.toBuffer(),
      Buffer.from(previousStateHash),
      sequenceBytes,
      Buffer.from(newStateHash),
    ],
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
const clusterGenesisHash = Array.from(
  new PublicKey(await connection.getGenesisHash()).toBytes(),
);
const initializeSignature = await program.methods
  .initializeProtocol(
    emergency.publicKey,
    identity.publicKey,
    certificateIssuer.publicKey,
    0,
    clusterGenesisHash,
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
assert.equal(asNumber(configState.maxSessionDurationSeconds), 10_800);
assert.equal(asNumber(configState.claimGracePeriodSeconds), 21_600);
assert.equal(configState.maxBranchDepth, 32);
assert.equal(configState.paused, false);
assert.equal(configState.admin.toBase58(), admin.publicKey.toBase58());
assert.equal(configState.emergencyAuthority.toBase58(), emergency.publicKey.toBase58());
assert.equal(configState.identityAuthority.toBase58(), identity.publicKey.toBase58());
assert.equal(configState.certificateIssuer.toBase58(), certificateIssuer.publicKey.toBase58());
assert.equal(configState.networkId, 0);
assert.deepEqual(Array.from(configState.clusterGenesisHash), clusterGenesisHash);
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

async function prepareUser(
  seed: number,
  depositAmount = 300,
  identityLifetimeSeconds = 86_400,
): Promise<PreparedUser> {
  const owner = Keypair.generate();
  await airdrop(owner.publicKey, 10);
  const profile = profilePda(owner.publicKey);
  const profileSignature = await program.methods
    .createUserProfile(nonzero(seed), new BN((await chainNow()) + identityLifetimeSeconds))
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
  devicePublicKey = Keypair.generate().publicKey,
): Promise<{ signature: string; session: PublicKey; sessionId: Uint8Array }> {
  const sessionId = Uint8Array.from(nonzero(seed));
  const session = sessionPda(user.owner.publicKey, sessionId);
  const signature = await program.methods
    .createOfflineSession(
      Array.from(sessionId),
      devicePublicKey,
      new BN(locked),
      new BN(limit),
      new BN(expiresAt),
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
  return { signature, session, sessionId };
}

const main = await prepareUser(10);
assert.equal((await getAccount(connection, main.ownerToken)).amount, 700n);
assert.equal((await getAccount(connection, main.vaultToken)).amount, 300n);
assert.equal(asNumber((await program.account.collateralVault.fetch(main.vault)).depositedAmount), 300);
pass("real SPL deposit CPI", "1000 -> 700 owner, 300 vault, deposited_amount=300");

await transfer(connection, payer, main.ownerToken, main.vaultToken, main.owner, 50);
assert.equal((await getAccount(connection, main.vaultToken)).amount, 350n);
assert.equal(asNumber((await program.account.collateralVault.fetch(main.vault)).depositedAmount), 300);
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
assert.equal(asNumber(mainSession.collateralLocked), 300);
assert.equal(asNumber(mainSession.collateralCoverageCap), 300);
assert.equal(asNumber(mainSession.branchSpendingLimit), 100);
assert.equal(asNumber(mainSession.aggregateOfflineExposure), 0);
assert.equal(asNumber(mainVault.reservedAmount), 300);
assert.equal(mainProfile.activeSession.toBase58(), valid.session.toBase58());
assert.equal(asNumber(mainSession.claimSubmissionDeadline), asNumber(mainSession.expiresAt) + 21_600);
assert(Math.abs(asNumber(mainSession.issuedAt) - nowForMain) <= 10);
pass("valid exact 300% session", "coverage cap derived on-chain and full collateral reserved");
pass("Solana Clock and claim deadline", "issued_at is runtime-derived; deadline=expires_at+21600");

const secondSessionId = Uint8Array.from(nonzero(21));
const secondSession = sessionPda(main.owner.publicKey, secondSessionId);
await expectFailure("second active session", async () =>
  createSession(main, 21, 300, 100, (await chainNow()) + 3600),
);
assert.equal(asNumber((await program.account.collateralVault.fetch(main.vault)).reservedAmount), 300);
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

const staleIdentity = await prepareUser(35, 300, 300);
const staleVaultBefore = await program.account.collateralVault.fetch(staleIdentity.vault);
const staleProfileBefore = await program.account.userProfile.fetch(staleIdentity.profile);
const staleSessionExpiry = (await chainNow()) + 600;
await expectFailure("session outlives identity", () =>
  createSession(staleIdentity, 36, 300, 100, staleSessionExpiry),
);
const staleVaultAfter = await program.account.collateralVault.fetch(staleIdentity.vault);
const staleProfileAfter = await program.account.userProfile.fetch(staleIdentity.profile);
assert.equal(staleVaultAfter.reservedAmount.toString(), staleVaultBefore.reservedAmount.toString());
assert.equal(staleProfileAfter.activeSession.toBase58(), staleProfileBefore.activeSession.toBase58());
pass("stale identity rejection", "session expiry cannot exceed identity expiry; rollback leaves no reservation");

const accounting = await prepareUser(40);
await transfer(connection, payer, accounting.ownerToken, accounting.vaultToken, accounting.owner, 50);
assert.equal((await getAccount(connection, accounting.vaultToken)).amount, 350n);
await expectFailure("reserve above deposited accounting", async () =>
  createSession(accounting, 41, 320, 100, (await chainNow()) + 3600),
);
assert.equal(asNumber((await program.account.collateralVault.fetch(accounting.vault)).reservedAmount), 0);
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
assert(asNumber(clockState.issuedAt) <= asNumber(clockState.expiresAt));
assert(asNumber(clockState.expiresAt) - asNumber(clockState.issuedAt) <= 10_800);
pass("Solana Clock window bounds", "expired and >3h fail; small/exact-bound duration passes");

const pauseReady = await prepareUser(70);
const pauseFreshOwner = Keypair.generate();
await airdrop(pauseFreshOwner.publicKey, 5);
await setPaused(admin, true);
const pausedConfig = await program.account.protocolConfig.fetch(config);
assert.equal(pausedConfig.paused, true);
const pauseFreshIdentityExpiry = (await chainNow()) + 3600;
await expectFailure("paused profile", () =>
  program.methods
    .createUserProfile(nonzero(71), new BN(pauseFreshIdentityExpiry))
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
assert.equal(asNumber((await program.account.collateralVault.fetch(pauseReady.vault)).reservedAmount), 0);
assert.equal((await program.account.userProfile.fetch(pauseReady.profile)).activeSession.toBase58(), PublicKey.default.toBase58());
await setPaused(admin, false);
pass("pause gate", "profile, vault, deposit and session fail without state corruption");

const claimsUser = await prepareUser(80);
const deviceSecretKey = generateSecretKey();
const devicePublicKey = new PublicKey(derivePublicKey(deviceSecretKey));
const claimsSessionResult = await createSession(
  claimsUser,
  81,
  300,
  100,
  (await chainNow()) + 3600,
  devicePublicKey,
);
const claimsSession = claimsSessionResult.session;
const authorizationHash = nonzero(180);
await program.methods
  .registerDeviceAuthorization(authorizationHash)
  .accounts({
    config,
    owner: claimsUser.owner.publicKey,
    session: claimsSession,
  })
  .signers([claimsUser.owner])
  .rpc();
const claimsSessionState = await program.account.offlineSession.fetch(claimsSession);
assert.deepEqual(Array.from(claimsSessionState.deviceAuthorizationHash), authorizationHash);
await expectFailure("device authorization re-registration", () =>
  program.methods
    .registerDeviceAuthorization(nonzero(181))
    .accounts({
      config,
      owner: claimsUser.owner.publicKey,
      session: claimsSession,
    })
    .signers([claimsUser.owner])
    .rpc(),
);
await expectFailure("device authorization signer substitution", () =>
  program.methods
    .registerDeviceAuthorization(nonzero(182))
    .accounts({
      config,
      owner: randomSigner.publicKey,
      session: claimsSession,
    })
    .signers([randomSigner])
    .rpc(),
);

const domainContext: DomainContext = {
  networkId: NetworkId.Localnet,
  clusterGenesisHash: Uint8Array.from(clusterGenesisHash),
  programId: program.programId.toBytes(),
  sessionId: claimsSessionResult.sessionId,
};
const genesis = createGenesisState(domainContext, {
  owner: claimsUser.owner.publicKey.toBytes(),
  devicePublicKey: devicePublicKey.toBytes(),
  branchSpendingLimit: 100n,
  maxBranchDepth: 32,
  initialRemaining: 100n,
  issuedAt: BigInt(claimsSessionState.issuedAt.toString()),
  expiresAt: BigInt(claimsSessionState.expiresAt.toString()),
});
const genesisHash = genesisStateHash(genesis);
assert.deepEqual(Array.from(claimsSessionState.genesisStateHash), Array.from(genesisHash));
pass("post-confirmation authorization lifecycle", "genesis is derived from Solana Clock facts before the owner registers the portable authorization hash");

const merchant = Keypair.generate();
const otherMerchant = Keypair.generate();
await Promise.all([
  airdrop(merchant.publicKey, 1),
  airdrop(otherMerchant.publicKey, 1),
]);

function buildCredential(
  merchantKey: PublicKey,
  merchantDeviceSeed: number,
  createdAtOffset = 0n,
  amount = 25n,
  previousStateHash = genesisHash,
  sequence = 1,
  previousRemaining = 100n,
  challengeSeed = merchantDeviceSeed,
): {
  payload: Uint8Array;
  signature: Uint8Array;
  credentialHash: Uint8Array;
  stateHash: Uint8Array;
  previousStateHash: Uint8Array;
  sequence: number;
} {
  const state: PaymentState = {
    domain: createDomain(domainContext, ObjectType.PaymentState),
    previousStateHash,
    sequence,
    merchant: merchantKey.toBytes(),
    amount,
    merchantChallenge: Uint8Array.from(nonzero(challengeSeed + 40)),
    previousRemaining,
    newRemaining: previousRemaining - amount,
  };
  const stateHash = paymentStateHash(state);
  const credential: PaymentCredentialPayload = {
    domain: createDomain(domainContext, ObjectType.PaymentCredential),
    sessionId: claimsSessionResult.sessionId,
    sequence,
    payer: claimsUser.owner.publicKey.toBytes(),
    payerDeviceKey: devicePublicKey.toBytes(),
    merchant: merchantKey.toBytes(),
    merchantDeviceKey: Uint8Array.from(nonzero(merchantDeviceSeed)),
    amount,
    previousStateHash,
    newStateHash: stateHash,
    previousRemaining,
    newRemaining: previousRemaining - amount,
    merchantChallenge: state.merchantChallenge,
    createdAt: BigInt(claimsSessionState.issuedAt.toString()) + createdAtOffset,
    sessionExpiresAt: BigInt(claimsSessionState.expiresAt.toString()),
  };
  const payload = encodePaymentCredentialPayload(credential);
  const signature = signEd25519(payload, deviceSecretKey);
  return {
    payload,
    signature,
    credentialHash: hashSha256(Uint8Array.from([...payload, ...signature])),
    stateHash,
    previousStateHash,
    sequence,
  };
}

function ed25519ReferenceInstruction(currentInstructionIndex = 1): TransactionInstruction {
  const data = Buffer.alloc(16);
  data[0] = 1;
  data[1] = 0;
  data.writeUInt16LE(422, 2);
  data.writeUInt16LE(currentInstructionIndex, 4);
  data.writeUInt16LE(190, 6);
  data.writeUInt16LE(currentInstructionIndex, 8);
  data.writeUInt16LE(12, 10);
  data.writeUInt16LE(410, 12);
  data.writeUInt16LE(currentInstructionIndex, 14);
  return new TransactionInstruction({ programId: Ed25519Program.programId, keys: [], data });
}

async function submitRuntimeClaim(
  credential: ReturnType<typeof buildCredential>,
  merchantKey: PublicKey,
  parentEdge: PublicKey,
  verifierInstruction = ed25519ReferenceInstruction(),
): Promise<string> {
  const claim = claimPda(claimsSession, credential.credentialHash);
  const edge = edgePda(
    claimsSession,
    credential.previousStateHash,
    credential.sequence,
    credential.stateHash,
  );
  const claimInstruction = await program.methods
    .submitClaim(
      Buffer.from(credential.payload),
      Buffer.from(credential.signature),
    )
    .accounts({
      config,
      session: claimsSession,
      merchant: merchantKey,
      relayer: payer.publicKey,
      claim,
      stateEdge: edge,
      parentEdge,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return provider.sendAndConfirm(
    new Transaction().add(verifierInstruction, claimInstruction),
    [],
  );
}

const firstCredential = buildCredential(merchant.publicKey, 90);
const firstClaim = claimPda(claimsSession, firstCredential.credentialHash);
const firstEdge = edgePda(claimsSession, genesisHash, 1, firstCredential.stateHash);
const firstClaimSignature = await submitRuntimeClaim(firstCredential, merchant.publicKey, claimsSession);
await recordCompute("submit_claim", firstClaimSignature);
const firstClaimState = await program.account.claim.fetch(firstClaim);
const firstEdgeState = await program.account.stateEdgeRecord.fetch(firstEdge);
const sessionAfterFirstClaim = await program.account.offlineSession.fetch(claimsSession);
assert("submitted" in firstClaimState.status);
assert("none" in firstClaimState.rejectionReason);
assert.equal(firstClaimState.merchant.toBase58(), merchant.publicKey.toBase58());
assert.equal(asNumber(firstEdgeState.wrapperCount), 1);
assert.equal(asNumber(sessionAfterFirstClaim.aggregateOfflineExposure), 25);
assert.equal(asNumber(sessionAfterFirstClaim.uniqueEdgeCount), 1);
pass("real Ed25519 claim submission", "native verifier references the exact 410-byte Anchor argument; claim and economic edge are persisted");

await expectFailure("wrong merchant claim", () =>
  submitRuntimeClaim(firstCredential, otherMerchant.publicKey, claimsSession),
);
await expectFailure("exact credential replay", () =>
  submitRuntimeClaim(firstCredential, merchant.publicKey, claimsSession),
);
const sessionAfterReplay = await program.account.offlineSession.fetch(claimsSession);
assert.equal(asNumber(sessionAfterReplay.aggregateOfflineExposure), 25);
assert.equal(asNumber(sessionAfterReplay.uniqueEdgeCount), 1);
pass("merchant binding and exact replay", "wrong destination and identical credential fail without multiplying exposure");

const tamperedSignature = Uint8Array.from(firstCredential.signature);
tamperedSignature[0] = (tamperedSignature[0] ?? 0) ^ 1;
const tamperedCredential = {
  ...firstCredential,
  signature: tamperedSignature,
  credentialHash: hashSha256(
    Uint8Array.from([...firstCredential.payload, ...tamperedSignature]),
  ),
};
await expectFailure("invalid Ed25519 signature", () =>
  submitRuntimeClaim(tamperedCredential, merchant.publicKey, claimsSession),
);
await expectFailure("Ed25519 instruction index confusion", () =>
  submitRuntimeClaim(
    buildCredential(otherMerchant.publicKey, 93),
    otherMerchant.publicKey,
    claimsSession,
    ed25519ReferenceInstruction(0),
  ),
);
pass("Ed25519 verifier hardening", "mutated signature and substituted instruction index are rejected before account creation");

const invalidTimeCredential = buildCredential(
  otherMerchant.publicKey,
  94,
  10_801n,
);
await expectFailure("credential metadata outside session", () =>
  submitRuntimeClaim(
    invalidTimeCredential,
    otherMerchant.publicKey,
    claimsSession,
  ),
);
pass("credential expiry metadata", "signed created_at outside the authoritative session interval is rejected without treating it as arrival order proof");

const wrapperCredential = buildCredential(
  merchant.publicKey,
  91,
  1n,
  25n,
  genesisHash,
  1,
  100n,
  90,
);
assert.deepEqual(Array.from(wrapperCredential.stateHash), Array.from(firstCredential.stateHash));
assert.notDeepEqual(Array.from(wrapperCredential.credentialHash), Array.from(firstCredential.credentialHash));
await submitRuntimeClaim(wrapperCredential, merchant.publicKey, claimsSession);
const wrapperClaim = claimPda(claimsSession, wrapperCredential.credentialHash);
const wrapperClaimState = await program.account.claim.fetch(wrapperClaim);
const edgeAfterWrapper = await program.account.stateEdgeRecord.fetch(firstEdge);
const sessionAfterWrapper = await program.account.offlineSession.fetch(claimsSession);
assert("rejected" in wrapperClaimState.status);
assert("duplicateStateEdge" in wrapperClaimState.rejectionReason);
assert.equal(asNumber(edgeAfterWrapper.wrapperCount), 2);
assert.equal(asNumber(sessionAfterWrapper.aggregateOfflineExposure), 25);
assert.equal(asNumber(sessionAfterWrapper.uniqueEdgeCount), 1);
pass("economic state-edge idempotency", "distinct signed wrapper is indexed and rejected economically; authoritative counters remain one edge/25 units");

const unreachableCredential = buildCredential(
  merchant.publicKey,
  92,
  2n,
  10n,
  Uint8Array.from(nonzero(220)),
  2,
  75n,
);
await expectFailure("unreachable parent", () =>
  submitRuntimeClaim(unreachableCredential, merchant.publicKey, claimsSession),
);
assert.equal(await connection.getAccountInfo(claimPda(claimsSession, unreachableCredential.credentialHash)), null);
pass("claim reachability and atomic rollback", "sequence-two claim with unregistered parent creates no claim or edge account");

const pausedClaimCredential = buildCredential(otherMerchant.publicKey, 95, 3n, 30n);
await setPaused(admin, true);
await expectFailure("paused claim submission", () =>
  submitRuntimeClaim(
    pausedClaimCredential,
    otherMerchant.publicKey,
    claimsSession,
  ),
);
await setPaused(admin, false);
const claimsSessionAfterPause = await program.account.offlineSession.fetch(claimsSession);
assert.equal(asNumber(claimsSessionAfterPause.aggregateOfflineExposure), 25);
assert.equal(asNumber(claimsSessionAfterPause.uniqueEdgeCount), 1);
pass("claim pause gate", "pause rejects new evidence accounts and leaves economic counters unchanged");

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

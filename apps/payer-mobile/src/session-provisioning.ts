import { encodeDeviceAuthorizationPayload } from "@ogp/canonical-codec";
import { createDomain, deviceAuthorizationHash, genesisStateHash, createGenesisState, validateCertificateChain, verifyDeviceAuthorization } from "@ogp/credentials";
import { derivePublicKey } from "@ogp/crypto";
import { MAX_BRANCH_DEPTH, ObjectType, equalBytes, type DeviceAuthorization, type SessionCertificate } from "@ogp/shared-types";
import type { OfflineTrustEnvironment } from "@ogp/transports";
import { createPersistedOnchainSession } from "./onchain-provisioning.js";
import { evaluatePayerRecovery, persistConfirmedProvisioning, type PayerRecoveryChainPort, type PayerRecoveryStoragePort } from "./onchain-recovery-controller.js";
import { bytesToHex, type PayerSessionRuntime } from "./payer-runtime.js";

const ZERO_32 = new Uint8Array(32);

export interface NewOfflineSessionRequest {
  readonly collateralLocked: bigint;
  readonly branchSpendingLimit: bigint;
  readonly expiresAt: bigint;
}

export interface SubmittedSessionTransaction {
  readonly signature: string;
  readonly sessionAccount: Uint8Array;
}

export interface ConfirmedProvisioningSession {
  readonly contextSlot: bigint;
  readonly sessionAccount: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly owner: Uint8Array;
  readonly devicePublicKey: Uint8Array;
  readonly vault: Uint8Array;
  readonly tokenMint: Uint8Array;
  readonly collateralLocked: bigint;
  readonly branchSpendingLimit: bigint;
  readonly collateralCoverageCap: bigint;
  readonly maxBranchDepth: number;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly claimSubmissionDeadline: bigint;
  readonly genesisStateHash: Uint8Array;
  readonly deviceAuthorizationHash: Uint8Array;
  readonly identityAttestationHash: Uint8Array;
  readonly status: "active";
}

/** Implemented by the MWA boundary. It never exposes a wallet private key. */
export interface MobileWalletProvisioningPort {
  readonly authorizeOwner: () => Promise<Uint8Array>;
  readonly createOfflineSession: (input: NewOfflineSessionRequest & {
    readonly owner: Uint8Array;
    readonly sessionId: Uint8Array;
    readonly devicePublicKey: Uint8Array;
  }) => Promise<SubmittedSessionTransaction>;
  readonly signDeviceAuthorizationMessage: (owner: Uint8Array, message: Uint8Array) => Promise<Uint8Array>;
  readonly registerDeviceAuthorization: (input: {
    readonly owner: Uint8Array;
    readonly sessionAccount: Uint8Array;
    readonly deviceAuthorizationHash: Uint8Array;
  }) => Promise<string>;
}

export interface ConfirmedProvisioningChainPort {
  /** Must confirm the signature and refetch the program-owned session at confirmed commitment. */
  readonly confirmAndFetchSession: (signature: string, sessionAccount: Uint8Array) => Promise<ConfirmedProvisioningSession>;
}

export interface CertificateIssuerPort {
  /** The service must independently refetch the registered session before signing. */
  readonly issue: (input: {
    readonly sessionAccount: Uint8Array;
    readonly deviceAuthorization: DeviceAuthorization;
  }) => Promise<SessionCertificate>;
}

export interface SecureEntropyPort {
  readonly random32: () => Uint8Array;
}

export interface ProvisionedPayerSession {
  readonly runtime: PayerSessionRuntime;
  readonly sessionAccount: Uint8Array;
  readonly creationSignature: string;
  readonly authorizationRegistrationSignature: string;
}

function assert32(value: Uint8Array, name: string, nonzero = false): void {
  if (value.length !== 32) throw new Error(`${name} deve conter exatamente 32 bytes`);
  if (nonzero && value.every((byte) => byte === 0)) throw new Error(`${name} não pode ser zero`);
}

function assert64(value: Uint8Array, name: string): void {
  if (value.length !== 64) throw new Error(`${name} deve conter exatamente 64 bytes`);
}

function assertEqual(left: Uint8Array, right: Uint8Array, name: string): void {
  if (!equalBytes(left, right)) throw new Error(`${name} não corresponde ao estado confirmado`);
}

function assertCreatedFacts(
  facts: ConfirmedProvisioningSession,
  expected: NewOfflineSessionRequest & { readonly owner: Uint8Array; readonly sessionId: Uint8Array; readonly devicePublicKey: Uint8Array; readonly sessionAccount: Uint8Array },
): void {
  for (const [value, name, nonzero] of [
    [facts.sessionAccount, "sessionAccount", true],
    [facts.sessionId, "sessionId", true],
    [facts.owner, "owner", true],
    [facts.devicePublicKey, "devicePublicKey", true],
    [facts.vault, "vault", true],
    [facts.tokenMint, "tokenMint", true],
    [facts.genesisStateHash, "genesisStateHash", true],
    [facts.deviceAuthorizationHash, "deviceAuthorizationHash", false],
    [facts.identityAttestationHash, "identityAttestationHash", true],
  ] as const) assert32(value, name, nonzero);
  if (facts.contextSlot < 0n) throw new Error("slot confirmado inválido");
  assertEqual(facts.sessionAccount, expected.sessionAccount, "sessionAccount");
  assertEqual(facts.sessionId, expected.sessionId, "sessionId");
  assertEqual(facts.owner, expected.owner, "owner");
  assertEqual(facts.devicePublicKey, expected.devicePublicKey, "devicePublicKey");
  if (facts.collateralLocked !== expected.collateralLocked || facts.branchSpendingLimit !== expected.branchSpendingLimit || facts.expiresAt !== expected.expiresAt) {
    throw new Error("limites da sessão não correspondem à transação solicitada");
  }
  if (facts.collateralCoverageCap !== facts.collateralLocked || facts.maxBranchDepth !== MAX_BRANCH_DEPTH) throw new Error("invariantes econômicos confirmados inválidos");
  if (facts.issuedAt >= facts.expiresAt || facts.claimSubmissionDeadline !== facts.expiresAt + 21_600n) throw new Error("janela temporal confirmada inválida");
  if (!equalBytes(facts.deviceAuthorizationHash, ZERO_32)) throw new Error("sessão recém-criada já possui autorização registrada");
}

function assertSameSession(left: ConfirmedProvisioningSession, right: ConfirmedProvisioningSession): void {
  for (const [first, second, name] of [
    [left.sessionAccount, right.sessionAccount, "sessionAccount"],
    [left.sessionId, right.sessionId, "sessionId"],
    [left.owner, right.owner, "owner"],
    [left.devicePublicKey, right.devicePublicKey, "devicePublicKey"],
    [left.vault, right.vault, "vault"],
    [left.tokenMint, right.tokenMint, "tokenMint"],
    [left.genesisStateHash, right.genesisStateHash, "genesisStateHash"],
    [left.identityAttestationHash, right.identityAttestationHash, "identityAttestationHash"],
  ] as const) assertEqual(first, second, name);
  const scalarMatch = left.collateralLocked === right.collateralLocked
    && left.branchSpendingLimit === right.branchSpendingLimit
    && left.collateralCoverageCap === right.collateralCoverageCap
    && left.maxBranchDepth === right.maxBranchDepth
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt
    && left.claimSubmissionDeadline === right.claimSubmissionDeadline;
  if (!scalarMatch || right.contextSlot < left.contextSlot) throw new Error("sessão mudou ou regrediu durante o provisionamento");
}

function assertCertificate(facts: ConfirmedProvisioningSession, certificate: SessionCertificate): void {
  for (const [certificateValue, chainValue, name] of [
    [certificate.sessionId, facts.sessionId, "sessionId"],
    [certificate.owner, facts.owner, "owner"],
    [certificate.devicePublicKey, facts.devicePublicKey, "devicePublicKey"],
    [certificate.vault, facts.vault, "vault"],
    [certificate.tokenMint, facts.tokenMint, "tokenMint"],
    [certificate.genesisStateHash, facts.genesisStateHash, "genesisStateHash"],
    [certificate.deviceAuthorizationHash, facts.deviceAuthorizationHash, "deviceAuthorizationHash"],
    [certificate.identityAttestationHash, facts.identityAttestationHash, "identityAttestationHash"],
  ] as const) assertEqual(certificateValue, chainValue, `certificado ${name}`);
  const scalarMatch = certificate.collateralLocked === facts.collateralLocked
    && certificate.branchSpendingLimit === facts.branchSpendingLimit
    && certificate.collateralCoverageCap === facts.collateralCoverageCap
    && certificate.maxBranchDepth === facts.maxBranchDepth
    && certificate.issuedAt === facts.issuedAt
    && certificate.expiresAt === facts.expiresAt
    && certificate.claimSubmissionDeadline === facts.claimSubmissionDeadline;
  if (!scalarMatch || certificate.finalizedSlot < facts.contextSlot) throw new Error("certificado não representa o estado confirmado registrado");
}

export async function provisionNewPayerSession(input: {
  readonly request: NewOfflineSessionRequest;
  readonly expectedEnvironment: OfflineTrustEnvironment;
  readonly storage: PayerRecoveryStoragePort;
  readonly recoveryChain: PayerRecoveryChainPort;
  readonly confirmedChain: ConfirmedProvisioningChainPort;
  readonly wallet: MobileWalletProvisioningPort;
  readonly issuer: CertificateIssuerPort;
  readonly entropy: SecureEntropyPort;
}): Promise<ProvisionedPayerSession> {
  const owner = await input.wallet.authorizeOwner();
  assert32(owner, "owner autorizado", true);
  const access = await evaluatePayerRecovery({ connected: true, walletOwnerHex: bytesToHex(owner), expectedEnvironment: input.expectedEnvironment }, input.storage, input.recoveryChain);
  if (access.decision.outcome !== "new-session-allowed") throw new Error(`provisionamento bloqueado: ${access.decision.reason}`);

  const deviceSecret = input.entropy.random32();
  const sessionId = input.entropy.random32();
  const authorizationNonce = input.entropy.random32();
  assert32(deviceSecret, "chave do dispositivo", true);
  assert32(sessionId, "sessionId", true);
  assert32(authorizationNonce, "authorizationNonce", true);
  const devicePublicKey = derivePublicKey(deviceSecret);
  if (equalBytes(owner, devicePublicKey)) throw new Error("wallet e chave da sessão devem ser distintas");

  const submitted = await input.wallet.createOfflineSession({ ...input.request, owner, sessionId, devicePublicKey });
  assert32(submitted.sessionAccount, "sessionAccount", true);
  if (submitted.signature.length === 0) throw new Error("assinatura da criação ausente");
  const created = await input.confirmedChain.confirmAndFetchSession(submitted.signature, submitted.sessionAccount);
  assertCreatedFacts(created, { ...input.request, owner, sessionId, devicePublicKey, sessionAccount: submitted.sessionAccount });

  const trustContext = { ...input.expectedEnvironment, sessionId };
  const authorizationPayload = {
    domain: createDomain(trustContext, ObjectType.DeviceAuthorization),
    owner,
    devicePublicKey,
    sessionId,
    vault: created.vault,
    branchSpendingLimit: created.branchSpendingLimit,
    collateralCoverageCap: created.collateralCoverageCap,
    maxBranchDepth: created.maxBranchDepth,
    issuedAt: created.issuedAt,
    expiresAt: created.expiresAt,
    authorizationNonce,
  };
  const walletSignature = await input.wallet.signDeviceAuthorizationMessage(owner, encodeDeviceAuthorizationPayload(authorizationPayload));
  assert64(walletSignature, "assinatura da wallet");
  const deviceAuthorization: DeviceAuthorization = { ...authorizationPayload, walletSignature };
  if (!verifyDeviceAuthorization(deviceAuthorization)) throw new Error("wallet retornou assinatura inválida para DeviceAuthorization");
  const authorizationHash = deviceAuthorizationHash(deviceAuthorization);

  const registrationSignature = await input.wallet.registerDeviceAuthorization({ owner, sessionAccount: submitted.sessionAccount, deviceAuthorizationHash: authorizationHash });
  if (registrationSignature.length === 0) throw new Error("assinatura do registro ausente");
  const registered = await input.confirmedChain.confirmAndFetchSession(registrationSignature, submitted.sessionAccount);
  assertSameSession(created, registered);
  assertEqual(registered.deviceAuthorizationHash, authorizationHash, "deviceAuthorizationHash registrado");

  const certificate = await input.issuer.issue({ sessionAccount: submitted.sessionAccount, deviceAuthorization });
  validateCertificateChain(trustContext, certificate, deviceAuthorization);
  assertCertificate(registered, certificate);
  const computedGenesis = genesisStateHash(createGenesisState(trustContext, {
    owner,
    devicePublicKey,
    branchSpendingLimit: registered.branchSpendingLimit,
    maxBranchDepth: registered.maxBranchDepth,
    initialRemaining: registered.branchSpendingLimit,
    issuedAt: registered.issuedAt,
    expiresAt: registered.expiresAt,
  }));
  assertEqual(computedGenesis, registered.genesisStateHash, "genesisStateHash recalculado");

  const runtime: PayerSessionRuntime = {
    deviceSecretHex: bytesToHex(deviceSecret),
    deviceAuthorization,
    sessionCertificate: certificate,
    trustContext,
    initialParent: { stateHash: computedGenesis, sequence: 0, remaining: registered.branchSpendingLimit },
  };
  const persisted = createPersistedOnchainSession({ sessionAccount: submitted.sessionAccount, runtime });
  await persistConfirmedProvisioning(input.storage, persisted);
  return { runtime, sessionAccount: submitted.sessionAccount, creationSignature: submitted.signature, authorizationRegistrationSignature: registrationSignature };
}

import { describe, expect, it, vi } from "vitest";
import { createDomain, createGenesisState, deviceAuthorizationHash, genesisStateHash, signSessionCertificate } from "@ogp/credentials";
import { derivePublicKey, signEd25519 } from "@ogp/crypto";
import { NetworkId, ObjectType, type DeviceAuthorization } from "@ogp/shared-types";
import type { OfflineTrustEnvironment } from "@ogp/transports";
import { restoreOnchainSession } from "../../apps/payer-mobile/src/onchain-provisioning.js";
import type { PayerRecoveryChainPort, PayerRecoveryStoragePort } from "../../apps/payer-mobile/src/onchain-recovery-controller.js";
import {
  provisionNewPayerSession,
  type ConfirmedProvisioningSession,
  type MobileWalletProvisioningPort,
} from "../../apps/payer-mobile/src/session-provisioning.js";
import { bytesToHex } from "../../apps/payer-mobile/src/payer-runtime.js";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const walletSecret = bytes(0x11);
const issuerSecret = bytes(0x22);
const owner = derivePublicKey(walletSecret);
const issuer = derivePublicKey(issuerSecret);
const sessionAccount = bytes(0x44);
const environment: OfflineTrustEnvironment = {
  networkId: NetworkId.Devnet,
  clusterGenesisHash: bytes(0xa1),
  programId: bytes(0xb2),
  trustedCertificateIssuer: issuer,
};

function recovery(active: boolean): PayerRecoveryChainPort {
  return {
    fetchConfirmedRecovery: vi.fn(async () => ({
      confirmed: true,
      profileOwner: bytesToHex(owner),
      offlineAccessEnabled: true,
      activeSessionAccount: active ? bytesToHex(sessionAccount) : null,
      sessionAccount: active ? bytesToHex(sessionAccount) : null,
      sessionId: active ? "04".repeat(32) : null,
      sessionOwner: active ? bytesToHex(owner) : null,
      sessionDevicePublicKey: active ? bytesToHex(derivePublicKey(bytes(0x03))) : null,
      sessionStatus: active ? "active" : null,
    })),
  };
}

function storage(): PayerRecoveryStoragePort & { readonly values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    values,
    load: async () => ({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null }),
    commit: async (snapshot) => {
      values.branch = snapshot.branchStateJson;
      values.provisioning = snapshot.provisioningJson;
      values.secret = snapshot.deviceSecretHex;
    },
  };
}

function facts(deviceAuthorizationHashValue = bytes(0), genesis = bytes(0x88)): ConfirmedProvisioningSession {
  return {
    contextSlot: deviceAuthorizationHashValue.every((value) => value === 0) ? 40n : 41n,
    sessionAccount,
    sessionId: bytes(0x04),
    owner,
    devicePublicKey: derivePublicKey(bytes(0x03)),
    vault: bytes(0x55),
    tokenMint: bytes(0x66),
    collateralLocked: 300n,
    branchSpendingLimit: 100n,
    collateralCoverageCap: 300n,
    maxBranchDepth: 32,
    issuedAt: 1_000n,
    expiresAt: 4_600n,
    claimSubmissionDeadline: 26_200n,
    genesisStateHash: genesis,
    deviceAuthorizationHash: deviceAuthorizationHashValue,
    identityAttestationHash: bytes(0x77),
    status: "active",
  };
}

function harness(options: { readonly active?: boolean; readonly genesis?: Uint8Array } = {}) {
  let registeredHash = bytes(0);
  const createdFacts = facts(bytes(0), options.genesis);
  const wallet: MobileWalletProvisioningPort = {
    authorizeOwner: vi.fn(async () => owner),
    createOfflineSession: vi.fn(async () => ({ signature: "create-signature", sessionAccount })),
    signDeviceAuthorizationMessage: vi.fn(async (_owner, message) => signEd25519(message, walletSecret)),
    registerDeviceAuthorization: vi.fn(async (input) => { registeredHash = input.deviceAuthorizationHash; return "register-signature"; }),
  };
  const confirmedChain = {
    confirmAndFetchSession: vi.fn(async (signature: string) => signature === "create-signature" ? createdFacts : facts(registeredHash, options.genesis)),
  };
  const issuerPort = {
    issue: vi.fn(async ({ deviceAuthorization }: { readonly deviceAuthorization: DeviceAuthorization }) => {
      const registered = facts(deviceAuthorizationHash(deviceAuthorization), options.genesis);
      const context = { ...environment, sessionId: registered.sessionId };
      return signSessionCertificate({
        domain: createDomain(context, ObjectType.SessionCertificate),
        sessionId: registered.sessionId,
        owner: registered.owner,
        devicePublicKey: registered.devicePublicKey,
        vault: registered.vault,
        tokenMint: registered.tokenMint,
        branchSpendingLimit: registered.branchSpendingLimit,
        collateralLocked: registered.collateralLocked,
        collateralCoverageCap: registered.collateralCoverageCap,
        maxBranchDepth: registered.maxBranchDepth,
        issuedAt: registered.issuedAt,
        expiresAt: registered.expiresAt,
        claimSubmissionDeadline: registered.claimSubmissionDeadline,
        genesisStateHash: registered.genesisStateHash,
        deviceAuthorizationHash: registered.deviceAuthorizationHash,
        identityAttestationHash: registered.identityAttestationHash,
        issuer,
        finalizedSlot: 41n,
        certificateNonce: bytes(0x05),
      }, issuerSecret);
    }),
  };
  return { wallet, confirmedChain, issuerPort, recoveryChain: recovery(options.active ?? false) };
}

describe("payer confirmed session provisioning", () => {
  it("executes create, confirmed refetch, wallet authorization, registration, issuer validation, and durable commit", async () => {
    const targetStorage = storage();
    const trustContext = { ...environment, sessionId: bytes(0x04) };
    const validGenesis = genesisStateHash(createGenesisState(trustContext, {
      owner,
      devicePublicKey: derivePublicKey(bytes(0x03)),
      branchSpendingLimit: 100n,
      maxBranchDepth: 32,
      initialRemaining: 100n,
      issuedAt: 1_000n,
      expiresAt: 4_600n,
    }));
    const valid = harness({ genesis: validGenesis });
    const result = await provisionNewPayerSession({
      request: { collateralLocked: 300n, branchSpendingLimit: 100n, expiresAt: 4_600n },
      expectedEnvironment: environment,
      storage: targetStorage,
      recoveryChain: valid.recoveryChain,
      confirmedChain: valid.confirmedChain,
      wallet: valid.wallet,
      issuer: valid.issuerPort,
      entropy: { random32: vi.fn().mockReturnValueOnce(bytes(0x03)).mockReturnValueOnce(bytes(0x04)).mockReturnValueOnce(bytes(0x05)) },
    });

    expect(result.creationSignature).toBe("create-signature");
    expect(valid.confirmedChain.confirmAndFetchSession).toHaveBeenCalledTimes(2);
    expect(Object.keys(targetStorage.values)).toEqual(["branch", "provisioning", "secret"]);
    expect(restoreOnchainSession(targetStorage.values.provisioning!, targetStorage.values.branch!, targetStorage.values.secret!, environment).parent.remaining).toBe(100n);
  });

  it("blocks creation when a confirmed active session already exists", async () => {
    const h = harness({ active: true });
    await expect(provisionNewPayerSession({
      request: { collateralLocked: 300n, branchSpendingLimit: 100n, expiresAt: 4_600n },
      expectedEnvironment: environment,
      storage: storage(),
      recoveryChain: h.recoveryChain,
      confirmedChain: h.confirmedChain,
      wallet: h.wallet,
      issuer: h.issuerPort,
      entropy: { random32: () => bytes(0x03) },
    })).rejects.toThrow(/provisionamento bloqueado/);
    expect(h.wallet.createOfflineSession).not.toHaveBeenCalled();
  });

  it("rejects an issuer-signed session whose confirmed genesis is inconsistent", async () => {
    const h = harness({ genesis: bytes(0x99) });
    const targetStorage = storage();
    await expect(provisionNewPayerSession({
      request: { collateralLocked: 300n, branchSpendingLimit: 100n, expiresAt: 4_600n },
      expectedEnvironment: environment,
      storage: targetStorage,
      recoveryChain: h.recoveryChain,
      confirmedChain: h.confirmedChain,
      wallet: h.wallet,
      issuer: h.issuerPort,
      entropy: { random32: vi.fn().mockReturnValueOnce(bytes(0x03)).mockReturnValueOnce(bytes(0x04)).mockReturnValueOnce(bytes(0x05)) },
    })).rejects.toThrow(/genesisStateHash recalculado/);
    expect(targetStorage.values).toEqual({});
  });
});

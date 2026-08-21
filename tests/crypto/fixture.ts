import { ObjectType, NetworkId, type DeviceAuthorization, type GenesisState, type PaymentCredential, type ProtocolTrustContext, type SessionCertificate } from "@ogp/shared-types";
import { derivePublicKey, generateSecretKey } from "@ogp/crypto";
import { createDomain, createGenesisState, createPaymentCredential, deviceAuthorizationHash, genesisStateHash, signDeviceAuthorization, signSessionCertificate, type ParentState } from "@ogp/credentials";

const filled = (value: number): Uint8Array => new Uint8Array(32).fill(value);

export interface ProtocolFixture {
  readonly context: ProtocolTrustContext;
  readonly walletSecret: Uint8Array;
  readonly deviceSecret: Uint8Array;
  readonly issuerSecret: Uint8Array;
  readonly authorization: DeviceAuthorization;
  readonly genesis: GenesisState;
  readonly certificate: SessionCertificate;
  readonly parent: ParentState;
  readonly credential: PaymentCredential;
}

export interface FixtureSecrets {
  readonly walletSecret: Uint8Array;
  readonly deviceSecret: Uint8Array;
  readonly issuerSecret: Uint8Array;
}

export function makeFixture(amount = 400n, merchantByte = 0x71, challengeByte = 0x91, secrets?: FixtureSecrets): ProtocolFixture {
  const walletSecret = secrets?.walletSecret.slice() ?? generateSecretKey();
  const deviceSecret = secrets?.deviceSecret.slice() ?? generateSecretKey();
  const issuerSecret = secrets?.issuerSecret.slice() ?? generateSecretKey();
  const sessionId = filled(0xc3);
  const context: ProtocolTrustContext = { networkId: NetworkId.Devnet, clusterGenesisHash: filled(0xa1), programId: filled(0xb2), sessionId, trustedCertificateIssuer: derivePublicKey(issuerSecret) };
  const issuedAt = 1_800_000_000n;
  const expiresAt = issuedAt + 10_800n;
  const owner = derivePublicKey(walletSecret);
  const devicePublicKey = derivePublicKey(deviceSecret);
  const authorization = signDeviceAuthorization({ domain: createDomain(context, ObjectType.DeviceAuthorization), owner, devicePublicKey, sessionId, vault: filled(0xd4), branchSpendingLimit: 1_000n, collateralCoverageCap: 3_000n, maxBranchDepth: 32, issuedAt, expiresAt, authorizationNonce: filled(0x11) }, walletSecret);
  const genesis = createGenesisState(context, { owner, devicePublicKey, branchSpendingLimit: 1_000n, maxBranchDepth: 32, initialRemaining: 1_000n, issuedAt, expiresAt });
  const genesisHash = genesisStateHash(genesis);
  const certificate = signSessionCertificate({ domain: createDomain(context, ObjectType.SessionCertificate), sessionId, owner, devicePublicKey, vault: authorization.vault, tokenMint: filled(0xe5), branchSpendingLimit: 1_000n, collateralLocked: 3_000n, collateralCoverageCap: 3_000n, maxBranchDepth: 32, issuedAt, expiresAt, claimSubmissionDeadline: expiresAt + 21_600n, genesisStateHash: genesisHash, deviceAuthorizationHash: deviceAuthorizationHash(authorization), identityAttestationHash: filled(0xf6), issuer: derivePublicKey(issuerSecret), finalizedSlot: 42n, certificateNonce: filled(0x22) }, issuerSecret);
  const parent: ParentState = { stateHash: genesisHash, sequence: 0, remaining: 1_000n };
  const credential = createPaymentCredential(context, certificate, parent, { merchant: filled(merchantByte), merchantDeviceKey: filled(merchantByte + 1), amount, merchantChallenge: filled(challengeByte), createdAt: issuedAt + 100n }, deviceSecret);
  return { context, walletSecret, deviceSecret, issuerSecret, authorization, genesis, certificate, parent, credential };
}

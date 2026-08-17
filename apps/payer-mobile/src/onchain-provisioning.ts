import {
  decodeDeviceAuthorization,
  decodeSessionCertificate,
  encodeDeviceAuthorization,
  encodeSessionCertificate,
} from "@ogp/canonical-codec";
import { derivePublicKey } from "@ogp/crypto";
import {
  createGenesisState,
  genesisStateHash,
  validateCertificateChain,
  validateCredentialProofBundle,
  type ParentState,
} from "@ogp/credentials";
import { equalBytes, type ProtocolTrustContext } from "@ogp/shared-types";
import { QRTransport, type OfflineTrustEnvironment } from "@ogp/transports";
import type { LocalProvisioningRecord } from "./session-access.js";
import {
  bytesToHex,
  hexToBytes,
  type PayerSessionRuntime,
  type RestoredPayerSession,
} from "./payer-runtime.js";

const PROVISIONING_VERSION = 1;
const BRANCH_STATE_VERSION = 1;
const HEX_32 = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

interface StoredOnchainProvisioningV1 {
  readonly version: 1;
  readonly source: "on-chain";
  readonly sessionAccount: string;
  readonly confirmedSessionSlot: string;
  readonly deviceAuthorizationHex: string;
  readonly sessionCertificateHex: string;
}

export interface StoredPayerBranchStateV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly stateHash: string;
  readonly sequence: number;
  readonly remaining: string;
  readonly frames: readonly string[];
  readonly pendingDelivery: boolean;
}

export interface PersistedOnchainSession {
  readonly provisioningJson: string;
  readonly branchStateJson: string;
  readonly deviceSecretHex: string;
}

export interface RestoredOnchainSession extends RestoredPayerSession {
  readonly localProvisioning: LocalProvisioningRecord;
  readonly confirmedSessionSlot: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} inválido`);
  return value as Record<string, unknown>;
}

function parseJson(value: string, name: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value) as unknown, name);
  } catch (reason) {
    if (reason instanceof Error && reason.message === `${name} inválido`) throw reason;
    throw new Error(`${name} não contém JSON válido`);
  }
}

function exactHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} deve conter exatamente ${bytes} bytes hexadecimais`);
  }
  return value;
}

function integerString(value: unknown, name: string): string {
  if (typeof value !== "string" || !POSITIVE_INTEGER.test(value)) throw new Error(`${name} inválido`);
  return value;
}

function parseProvisioning(value: string): StoredOnchainProvisioningV1 {
  const parsed = parseJson(value, "provisionamento on-chain");
  if (parsed.version !== PROVISIONING_VERSION || parsed.source !== "on-chain") throw new Error("versão ou origem do provisionamento on-chain inválida");
  return {
    version: 1,
    source: "on-chain",
    sessionAccount: exactHex(parsed.sessionAccount, 32, "sessionAccount"),
    confirmedSessionSlot: integerString(parsed.confirmedSessionSlot, "confirmedSessionSlot"),
    deviceAuthorizationHex: exactHex(parsed.deviceAuthorizationHex, 370, "deviceAuthorization"),
    sessionCertificateHex: exactHex(parsed.sessionCertificateHex, 554, "sessionCertificate"),
  };
}

function parseBranchState(value: string): StoredPayerBranchStateV1 {
  const parsed = parseJson(value, "estado local da sessão");
  if (parsed.version !== BRANCH_STATE_VERSION) throw new Error("versão do estado local da sessão inválida");
  if (!Number.isInteger(parsed.sequence) || (parsed.sequence as number) < 0 || (parsed.sequence as number) > 0xffff_ffff) throw new Error("sequência local inválida");
  if (!Array.isArray(parsed.frames) || !parsed.frames.every((frame) => typeof frame === "string" && frame.length > 0)) throw new Error("frames locais inválidos");
  if (typeof parsed.pendingDelivery !== "boolean") throw new Error("estado de entrega local inválido");
  if (parsed.pendingDelivery && parsed.frames.length === 0) throw new Error("entrega pendente exige prova persistida");
  return {
    version: 1,
    sessionId: exactHex(parsed.sessionId, 32, "sessionId local"),
    stateHash: exactHex(parsed.stateHash, 32, "stateHash local"),
    sequence: parsed.sequence as number,
    remaining: integerString(parsed.remaining, "saldo local"),
    frames: parsed.frames as string[],
    pendingDelivery: parsed.pendingDelivery,
  };
}

function trustContext(expected: OfflineTrustEnvironment, sessionId: Uint8Array): ProtocolTrustContext {
  return { ...expected, sessionId };
}

function initialParent(runtime: Omit<PayerSessionRuntime, "initialParent">): ParentState {
  const certificate = runtime.sessionCertificate;
  const genesis = createGenesisState(runtime.trustContext, {
    owner: certificate.owner,
    devicePublicKey: certificate.devicePublicKey,
    branchSpendingLimit: certificate.branchSpendingLimit,
    maxBranchDepth: certificate.maxBranchDepth,
    initialRemaining: certificate.branchSpendingLimit,
    issuedAt: certificate.issuedAt,
    expiresAt: certificate.expiresAt,
  });
  return { stateHash: genesisStateHash(genesis), sequence: 0, remaining: certificate.branchSpendingLimit };
}

function assertParentMatches(parent: ParentState, stored: StoredPayerBranchStateV1): void {
  if (bytesToHex(parent.stateHash) !== stored.stateHash || parent.sequence !== stored.sequence || parent.remaining.toString() !== stored.remaining) {
    throw new Error("estado local não corresponde à cadeia criptográfica persistida");
  }
}

function exactObject(value: Uint8Array, expected: Uint8Array, name: string): void {
  if (!equalBytes(value, expected)) throw new Error(`${name} da prova não corresponde ao provisionamento`);
}

export function restoreOnchainSession(
  provisioningJson: string,
  branchStateJson: string,
  deviceSecretHex: string,
  expected: OfflineTrustEnvironment,
): RestoredOnchainSession {
  const provisioning = parseProvisioning(provisioningJson);
  const storedBranch = parseBranchState(branchStateJson);
  const deviceSecret = hexToBytes(exactHex(deviceSecretHex, 32, "chave protegida da sessão"));
  const deviceAuthorization = decodeDeviceAuthorization(hexToBytes(provisioning.deviceAuthorizationHex));
  const sessionCertificate = decodeSessionCertificate(hexToBytes(provisioning.sessionCertificateHex));
  const context = trustContext(expected, sessionCertificate.sessionId);

  validateCertificateChain(context, sessionCertificate, deviceAuthorization);
  if (!equalBytes(derivePublicKey(deviceSecret), sessionCertificate.devicePublicKey)) throw new Error("chave protegida não corresponde ao dispositivo autorizado");
  if (storedBranch.sessionId !== bytesToHex(sessionCertificate.sessionId)) throw new Error("estado local pertence a outra sessão");
  if (provisioning.confirmedSessionSlot !== sessionCertificate.finalizedSlot.toString()) throw new Error("slot confirmado não corresponde ao certificado assinado");

  const base = { deviceSecretHex, deviceAuthorization, sessionCertificate, trustContext: context };
  const genesisParent = initialParent(base);
  const runtime: PayerSessionRuntime = { ...base, initialParent: genesisParent };
  let parent = genesisParent;
  let credentials = [] as RestoredPayerSession["credentials"];

  if (storedBranch.frames.length > 0) {
    const bundle = new QRTransport().receiveCredential(storedBranch.frames);
    exactObject(encodeDeviceAuthorization(bundle.deviceAuthorization), encodeDeviceAuthorization(deviceAuthorization), "autorização");
    exactObject(encodeSessionCertificate(bundle.sessionCertificate), encodeSessionCertificate(sessionCertificate), "certificado");
    parent = validateCredentialProofBundle(context, bundle);
    credentials = [...bundle.credentials];
  }
  assertParentMatches(parent, storedBranch);

  const owner = bytesToHex(sessionCertificate.owner);
  const devicePublicKey = bytesToHex(sessionCertificate.devicePublicKey);
  return {
    runtime,
    parent,
    credentials,
    outgoingFrames: [...storedBranch.frames],
    pendingDelivery: storedBranch.pendingDelivery,
    confirmedSessionSlot: provisioning.confirmedSessionSlot,
    localProvisioning: {
      source: "on-chain",
      provisioningConfirmed: true,
      sessionAccount: provisioning.sessionAccount,
      sessionId: bytesToHex(sessionCertificate.sessionId),
      branchStateSessionId: storedBranch.sessionId,
      owner,
      certificateOwner: owner,
      devicePublicKey,
      certificateDevicePublicKey: devicePublicKey,
      protectedDeviceKeyPublicKey: bytesToHex(derivePublicKey(deviceSecret)),
      branchStatePresent: true,
    },
  };
}

export function createPersistedOnchainSession(input: {
  readonly sessionAccount: Uint8Array;
  readonly runtime: PayerSessionRuntime;
  readonly parent?: ParentState;
  readonly frames?: readonly string[];
  readonly pendingDelivery?: boolean;
}): PersistedOnchainSession {
  if (input.sessionAccount.length !== 32) throw new Error("sessionAccount deve conter 32 bytes");
  validateCertificateChain(input.runtime.trustContext, input.runtime.sessionCertificate, input.runtime.deviceAuthorization);
  const protectedPublicKey = derivePublicKey(hexToBytes(exactHex(input.runtime.deviceSecretHex, 32, "chave protegida da sessão")));
  if (!equalBytes(protectedPublicKey, input.runtime.sessionCertificate.devicePublicKey)) throw new Error("chave protegida não corresponde ao certificado");

  const parent = input.parent ?? input.runtime.initialParent;
  const frames = [...(input.frames ?? [])];
  const provisioning: StoredOnchainProvisioningV1 = {
    version: 1,
    source: "on-chain",
    sessionAccount: bytesToHex(input.sessionAccount),
    confirmedSessionSlot: input.runtime.sessionCertificate.finalizedSlot.toString(),
    deviceAuthorizationHex: bytesToHex(encodeDeviceAuthorization(input.runtime.deviceAuthorization)),
    sessionCertificateHex: bytesToHex(encodeSessionCertificate(input.runtime.sessionCertificate)),
  };
  const branch: StoredPayerBranchStateV1 = {
    version: 1,
    sessionId: bytesToHex(input.runtime.sessionCertificate.sessionId),
    stateHash: bytesToHex(parent.stateHash),
    sequence: parent.sequence,
    remaining: parent.remaining.toString(),
    frames,
    pendingDelivery: input.pendingDelivery ?? false,
  };
  const persisted = {
    provisioningJson: JSON.stringify(provisioning),
    branchStateJson: JSON.stringify(branch),
    deviceSecretHex: input.runtime.deviceSecretHex,
  };
  const expected: OfflineTrustEnvironment = {
    networkId: input.runtime.trustContext.networkId,
    clusterGenesisHash: input.runtime.trustContext.clusterGenesisHash,
    programId: input.runtime.trustContext.programId,
    trustedCertificateIssuer: input.runtime.trustContext.trustedCertificateIssuer,
  };
  restoreOnchainSession(persisted.provisioningJson, persisted.branchStateJson, persisted.deviceSecretHex, expected);
  return persisted;
}

export function hasCompleteOnchainStorage(provisioningJson: string | null, branchStateJson: string | null, deviceSecretHex: string | null): boolean {
  return provisioningJson !== null && branchStateJson !== null && deviceSecretHex !== null;
}

export function isSessionAccountHex(value: string): boolean {
  return HEX_32.test(value);
}

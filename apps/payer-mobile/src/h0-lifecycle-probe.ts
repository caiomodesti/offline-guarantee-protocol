import { hashSha256 } from "@ogp/crypto";
import type { OfflineTrustEnvironment } from "@ogp/transports";
import { loadDevelopmentSession } from "./dev-session.js";
import { createPersistedOnchainSession, type PersistedOnchainSession } from "./onchain-provisioning.js";
import { evaluatePayerRecovery, type PayerRecoveryStorageSnapshot } from "./onchain-recovery-controller.js";
import { bytesToHex } from "./payer-runtime.js";

export const H0_PUBLIC_COPY_PREFIX = "OGP:H0:PUBLIC-COPY:V1:";
export const H0_PUBLIC_COPY_MAX_QR_BYTES = 2_953;

export interface H0PublicCopyV1 {
  readonly version: 1;
  readonly provisioningJson: string;
  readonly branchStateJson: string;
}

export interface H0ProbeMaterial {
  readonly persisted: PersistedOnchainSession;
  readonly publicCopy: H0PublicCopyV1;
  readonly publicCopyJson: string;
  readonly publicCopyHash: string;
  readonly expectedEnvironment: OfflineTrustEnvironment;
}

export interface H0ProbeResult {
  readonly outcome: string;
  readonly localValidationError: string | null;
  readonly economicAuthorityAvailable: boolean;
}

function publicCopyJson(copy: H0PublicCopyV1): string {
  return JSON.stringify({
    version: copy.version,
    provisioningJson: copy.provisioningJson,
    branchStateJson: copy.branchStateJson,
  });
}

export function parseH0PublicCopy(value: string): H0PublicCopyV1 {
  if (new TextEncoder().encode(value).length > H0_PUBLIC_COPY_MAX_QR_BYTES) throw new Error("cópia pública H0 excede o limite do QR");
  const payload = value.startsWith(H0_PUBLIC_COPY_PREFIX) ? value.slice(H0_PUBLIC_COPY_PREFIX.length) : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("cópia pública H0 não contém JSON válido");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("cópia pública H0 inválida");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.provisioningJson !== "string" || typeof record.branchStateJson !== "string") {
    throw new Error("cópia pública H0 inválida");
  }
  const exactKeys = Object.keys(record).sort().join(",");
  if (exactKeys !== "branchStateJson,provisioningJson,version") throw new Error("cópia pública H0 contém campos inesperados");
  return { version: 1, provisioningJson: record.provisioningJson, branchStateJson: record.branchStateJson };
}

export function hashH0PublicCopy(copy: H0PublicCopyV1): string {
  return bytesToHex(hashSha256(new TextEncoder().encode(publicCopyJson(copy))));
}

export function createH0ProbeMaterial(): H0ProbeMaterial {
  const runtime = loadDevelopmentSession();
  const persisted = createPersistedOnchainSession({ sessionAccount: new Uint8Array(32).fill(0x44), runtime });
  const publicCopy: H0PublicCopyV1 = {
    version: 1,
    provisioningJson: persisted.provisioningJson,
    branchStateJson: persisted.branchStateJson,
  };
  const serialized = publicCopyJson(publicCopy);
  return {
    persisted,
    publicCopy,
    publicCopyJson: serialized,
    publicCopyHash: hashH0PublicCopy(publicCopy),
    expectedEnvironment: {
      networkId: runtime.trustContext.networkId,
      clusterGenesisHash: runtime.trustContext.clusterGenesisHash,
      programId: runtime.trustContext.programId,
      trustedCertificateIssuer: runtime.trustContext.trustedCertificateIssuer,
    },
  };
}

export async function evaluateH0Snapshot(snapshot: PayerRecoveryStorageSnapshot): Promise<H0ProbeResult> {
  const material = createH0ProbeMaterial();
  const result = await evaluatePayerRecovery(
    { connected: false, walletOwnerHex: null, expectedEnvironment: material.expectedEnvironment },
    {
      load: async () => snapshot,
      writeBranchState: async () => undefined,
      writeProvisioning: async () => undefined,
      writeProtectedDeviceSecret: async () => undefined,
    },
    { fetchConfirmedRecovery: async () => { throw new Error("RPC proibido no probe H0 offline"); } },
  );
  return {
    outcome: result.decision.outcome,
    localValidationError: result.localValidationError,
    economicAuthorityAvailable: result.decision.outcome === "offline-ready" && result.restoredSession !== null,
  };
}

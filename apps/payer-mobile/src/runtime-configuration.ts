import { NetworkId } from "@ogp/shared-types";
import type { OfflineTrustEnvironment } from "@ogp/transports";
import { hexToBytes } from "./payer-runtime";

export interface PayerRuntimeEnvironment {
  readonly EXPO_PUBLIC_OGP_NETWORK_ID?: string;
  readonly EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX?: string;
  readonly EXPO_PUBLIC_OGP_PROGRAM_ID_HEX?: string;
  readonly EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX?: string;
}

function bytes32(value: string | undefined, name: string): Uint8Array {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} deve conter exatamente 32 bytes hexadecimais`);
  return hexToBytes(value);
}

function networkId(value: string | undefined): NetworkId {
  if (value === "localnet") return NetworkId.Localnet;
  if (value === "devnet") return NetworkId.Devnet;
  if (value === "mainnet-beta") return NetworkId.MainnetBeta;
  throw new Error("EXPO_PUBLIC_OGP_NETWORK_ID deve ser localnet, devnet ou mainnet-beta");
}

/** Public deployment trust roots. Secrets are never accepted through Expo environment variables. */
export function configuredTrustEnvironment(environment: PayerRuntimeEnvironment): OfflineTrustEnvironment {
  return {
    networkId: networkId(environment.EXPO_PUBLIC_OGP_NETWORK_ID),
    clusterGenesisHash: bytes32(environment.EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX, "cluster genesis hash"),
    programId: bytes32(environment.EXPO_PUBLIC_OGP_PROGRAM_ID_HEX, "program ID"),
    trustedCertificateIssuer: bytes32(environment.EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX, "certificate issuer"),
  };
}

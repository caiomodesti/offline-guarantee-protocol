import { NetworkId } from "@ogp/shared-types";
import type { OfflineTrustEnvironment } from "@ogp/transports";

export interface MerchantRuntimeConfiguration {
  readonly trust: OfflineTrustEnvironment;
  readonly merchant: Uint8Array;
  readonly rpcUrl: string;
  readonly relayerUrl: string;
}

export interface MerchantRuntimeEnvironment {
  readonly EXPO_PUBLIC_OGP_NETWORK_ID?: string;
  readonly EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX?: string;
  readonly EXPO_PUBLIC_OGP_PROGRAM_ID_HEX?: string;
  readonly EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX?: string;
  readonly EXPO_PUBLIC_OGP_MERCHANT_HEX?: string;
  readonly EXPO_PUBLIC_OGP_RPC_URL?: string;
  readonly EXPO_PUBLIC_OGP_RELAYER_URL?: string;
}

function bytes32(value: string | undefined, name: string): Uint8Array {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} deve conter exatamente 32 bytes hexadecimais`);
  const decoded = Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
  if (decoded.every((byte) => byte === 0)) throw new Error(`${name} não pode ser zero`);
  return decoded;
}

function networkId(value: string | undefined): NetworkId {
  if (value === "localnet") return NetworkId.Localnet;
  if (value === "devnet") return NetworkId.Devnet;
  if (value === "mainnet-beta") return NetworkId.MainnetBeta;
  throw new Error("EXPO_PUBLIC_OGP_NETWORK_ID deve ser localnet, devnet ou mainnet-beta");
}

function endpoint(value: string | undefined, name: string, allowLocalHttp: boolean, allowQuery: boolean): string {
  if (value === undefined) throw new Error(`${name} é obrigatória`);
  const parsed = new URL(value);
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowLocalHttp && local && parsed.protocol === "http:")) {
    throw new Error(`${name} deve usar HTTPS${allowLocalHttp ? " ou HTTP local" : ""}`);
  }
  if (parsed.username !== "" || parsed.password !== "") throw new Error(`${name} não pode conter credenciais`);
  if (!allowQuery && (parsed.search !== "" || parsed.hash !== "")) throw new Error(`${name} não pode conter query ou fragmento`);
  return parsed.toString();
}

/** Parses public deployment roots only. No wallet, device, issuer or relayer secret is accepted. */
export function configuredMerchantRuntime(environment: MerchantRuntimeEnvironment): MerchantRuntimeConfiguration {
  const programId = bytes32(environment.EXPO_PUBLIC_OGP_PROGRAM_ID_HEX, "program ID");
  return {
    trust: {
      networkId: networkId(environment.EXPO_PUBLIC_OGP_NETWORK_ID),
      clusterGenesisHash: bytes32(environment.EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX, "cluster genesis hash"),
      programId,
      trustedCertificateIssuer: bytes32(environment.EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX, "certificate issuer"),
    },
    merchant: bytes32(environment.EXPO_PUBLIC_OGP_MERCHANT_HEX, "merchant"),
    rpcUrl: endpoint(environment.EXPO_PUBLIC_OGP_RPC_URL, "RPC URL", true, true),
    relayerUrl: endpoint(environment.EXPO_PUBLIC_OGP_RELAYER_URL, "relayer URL", true, false),
  };
}

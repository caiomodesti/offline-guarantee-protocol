import { describe, expect, it } from "vitest";
import { NetworkId } from "@ogp/shared-types";
import { configuredTrustEnvironment } from "../../apps/payer-mobile/src/runtime-configuration.js";
import { configuredMerchantRuntime } from "../../apps/merchant-mobile/src/runtime-configuration.js";

const valid = {
  EXPO_PUBLIC_OGP_NETWORK_ID: "devnet",
  EXPO_PUBLIC_OGP_CLUSTER_GENESIS_HASH_HEX: "11".repeat(32),
  EXPO_PUBLIC_OGP_PROGRAM_ID_HEX: "22".repeat(32),
  EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX: "33".repeat(32),
} as const;

describe("payer public trust configuration", () => {
  it("accepts exact public deployment roots", () => {
    expect(configuredTrustEnvironment(valid)).toMatchObject({ networkId: NetworkId.Devnet });
    expect(configuredTrustEnvironment(valid).programId).toEqual(new Uint8Array(32).fill(0x22));
  });

  it("fails closed when the network or any 32-byte root is missing or malformed", () => {
    expect(() => configuredTrustEnvironment({ ...valid, EXPO_PUBLIC_OGP_NETWORK_ID: "testnet" })).toThrow(/NETWORK_ID/);
    expect(() => configuredTrustEnvironment({ ...valid, EXPO_PUBLIC_OGP_PROGRAM_ID_HEX: "22" })).toThrow(/program ID/);
    const { EXPO_PUBLIC_OGP_CERTIFICATE_ISSUER_HEX: _issuer, ...withoutIssuer } = valid;
    expect(() => configuredTrustEnvironment(withoutIssuer)).toThrow(/certificate issuer/);
  });
});

const validMerchant = {
  ...valid,
  EXPO_PUBLIC_OGP_MERCHANT_HEX: "44".repeat(32),
  EXPO_PUBLIC_OGP_RPC_URL: "https://rpc.example/?api-key=public-deployment-token",
  EXPO_PUBLIC_OGP_RELAYER_URL: "https://relay.example/ogp",
} as const;

describe("merchant public runtime configuration", () => {
  it("requires a complete public deployment configuration", () => {
    const runtime = configuredMerchantRuntime(validMerchant);
    expect(runtime.trust.networkId).toBe(NetworkId.Devnet);
    expect(runtime.merchant).toEqual(new Uint8Array(32).fill(0x44));
    expect(runtime.relayerUrl).toBe("https://relay.example/ogp");
  });

  it("fails closed for missing identities, insecure remote endpoints or embedded credentials", () => {
    const { EXPO_PUBLIC_OGP_MERCHANT_HEX: _merchant, ...withoutMerchant } = validMerchant;
    expect(() => configuredMerchantRuntime(withoutMerchant)).toThrow(/merchant/);
    expect(() => configuredMerchantRuntime({ ...validMerchant, EXPO_PUBLIC_OGP_RPC_URL: "http://rpc.example" })).toThrow(/HTTPS/);
    expect(() => configuredMerchantRuntime({ ...validMerchant, EXPO_PUBLIC_OGP_RELAYER_URL: "https://user:pass@relay.example" })).toThrow(/credenciais/);
    expect(() => configuredMerchantRuntime({ ...validMerchant, EXPO_PUBLIC_OGP_RELAYER_URL: "https://relay.example?claim=1" })).toThrow(/query/);
  });
});

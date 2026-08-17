import { describe, expect, it } from "vitest";
import { NetworkId } from "@ogp/shared-types";
import { configuredTrustEnvironment } from "../../apps/payer-mobile/src/runtime-configuration.js";

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

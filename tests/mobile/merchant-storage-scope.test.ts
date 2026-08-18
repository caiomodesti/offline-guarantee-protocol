import { describe, expect, it } from "vitest";
import { NetworkId } from "@ogp/shared-types";
import { merchantStorageKeys } from "../../apps/merchant-mobile/src/storage-scope.js";
import type { MerchantRuntimeConfiguration } from "../../apps/merchant-mobile/src/runtime-configuration.js";

function runtime(marker: number): MerchantRuntimeConfiguration {
  return {
    trust: {
      networkId: NetworkId.Devnet,
      clusterGenesisHash: new Uint8Array(32).fill(0x11),
      programId: new Uint8Array(32).fill(marker),
      trustedCertificateIssuer: new Uint8Array(32).fill(0x33),
    },
    merchant: new Uint8Array(32).fill(0x44),
    rpcUrl: "https://rpc.example",
    relayerUrl: "https://relay.example",
  };
}

describe("merchant storage domain scope", () => {
  it("isolates production evidence when any deployment identity changes", () => {
    const first = merchantStorageKeys(runtime(0x22), false);
    const second = merchantStorageKeys(runtime(0x23), false);
    expect(first.claims).not.toBe(second.claims);
    expect(first.deviceKey).not.toBe(second.deviceKey);
    expect(first.outstandingChallenge).not.toBe(second.outstandingChallenge);
    expect(first.durableNamespace).not.toBe(second.durableNamespace);
  });

  it("preserves the historical Sprint 7 namespace only for the explicit demo", () => {
    expect(merchantStorageKeys(runtime(0x22), true)).toEqual({
      deviceKey: "ogp.merchant.device-key",
      claims: "ogp.merchant.pending-claims",
      outstandingChallenge: "ogp.merchant.outstanding-challenge",
      durableNamespace: "ogp.merchant.demo.storage.v1",
    });
  });
});

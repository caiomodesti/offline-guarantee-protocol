import type { MerchantRuntimeConfiguration } from "./runtime-configuration";

export interface MerchantStorageKeys {
  readonly deviceKey: string;
  readonly claims: string;
  readonly outstandingChallenge: string;
  readonly durableNamespace: string;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const LEGACY_KEYS: MerchantStorageKeys = {
  deviceKey: "ogp.merchant.device-key",
  claims: "ogp.merchant.pending-claims",
  outstandingChallenge: "ogp.merchant.outstanding-challenge",
  durableNamespace: "ogp.merchant.demo.storage.v1",
};

/** Public domain scoping prevents demo or another deployment from sharing durable evidence/device identity. */
export function merchantStorageKeys(runtime: MerchantRuntimeConfiguration, historicalDemonstration: boolean): MerchantStorageKeys {
  if (historicalDemonstration) return LEGACY_KEYS;
  const scope = `${runtime.trust.networkId}.${hex(runtime.trust.clusterGenesisHash)}.${hex(runtime.trust.programId)}.${hex(runtime.merchant)}`;
  return {
    deviceKey: `ogp.merchant.device-key.${scope}`,
    claims: `ogp.merchant.claims.v1.${scope}`,
    outstandingChallenge: `ogp.merchant.outstanding-challenge.${scope}`,
    durableNamespace: `ogp.merchant.storage.v1.${scope}`,
  };
}

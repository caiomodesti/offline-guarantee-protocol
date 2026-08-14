import { NetworkId } from "@ogp/shared-types";

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) throw new Error("invalid hex");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const expectedEnvironment = {
  networkId: NetworkId.Devnet,
  clusterGenesisHash: hexToBytes("a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"),
  programId: hexToBytes("b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"),
  trustedCertificateIssuer: hexToBytes("ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1"),
} as const;

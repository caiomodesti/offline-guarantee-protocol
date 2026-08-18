import { describe, expect, it } from "vitest";
import {
  createMerchantCrashConsistentStorage,
  type MerchantDurableSnapshot,
} from "../../apps/merchant-mobile/src/merchant-crash-storage.js";
import { MemoryDurableStorage, testGeneration } from "./mobile-storage-memory.js";

const namespace = "ogp.test.merchant.storage.v1";
const first: MerchantDurableSnapshot = {
  deviceSecretHex: "11".repeat(32),
  claimsJson: "[]",
  outstandingChallengeJson: '{"challenge":"first"}',
};
const second: MerchantDurableSnapshot = {
  ...first,
  claimsJson: '[{"claim":"stored"}]',
  outstandingChallengeJson: null,
};

function emptyLegacy() {
  return { load: async () => ({ deviceSecretHex: null, claimsJson: null, outstandingChallengeJson: null }) };
}

describe("merchant crash-consistent storage adapter", () => {
  it("migrates a complete legacy tuple as one durable generation", async () => {
    const memory = new MemoryDurableStorage();
    const storage = createMerchantCrashConsistentStorage(
      namespace,
      memory,
      { load: async () => ({ deviceSecretHex: first.deviceSecretHex, claimsJson: first.claimsJson, outstandingChallengeJson: first.outstandingChallengeJson }) },
      () => testGeneration(1),
    );

    await expect(storage.load()).resolves.toEqual(first);
    await expect(storage.load()).resolves.toEqual(first);
  });

  it("rejects public merchant evidence without its protected device identity", async () => {
    const storage = createMerchantCrashConsistentStorage(
      namespace,
      new MemoryDurableStorage(),
      { load: async () => ({ deviceSecretHex: null, claimsJson: first.claimsJson, outstandingChallengeJson: null }) },
      () => testGeneration(1),
    );

    await expect(storage.load()).rejects.toThrow(/sem a chave protegida/i);
  });

  it("atomically stores evidence and clears its challenge across every pre-commit failure", async () => {
    for (let failAt = 1; failAt <= 6; failAt += 1) {
      const memory = new MemoryDurableStorage();
      let generation = 0;
      const storage = createMerchantCrashConsistentStorage(namespace, memory, emptyLegacy(), () => testGeneration(++generation));
      await storage.initialize(first.deviceSecretHex);
      await storage.update(() => first);
      memory.resetFault(failAt);
      await expect(storage.update(() => second)).rejects.toThrow(`fault-${failAt}`);
      memory.resetFault(null);
      await expect(storage.load()).resolves.toEqual(first);
    }
  });

  it("serializes concurrent updates so neither merchant claim is lost", async () => {
    const memory = new MemoryDurableStorage();
    let generation = 0;
    const storage = createMerchantCrashConsistentStorage(namespace, memory, emptyLegacy(), () => testGeneration(++generation));
    await storage.initialize(first.deviceSecretHex);

    await Promise.all([
      storage.update((current) => ({ ...current, claimsJson: `${current.claimsJson}A` })),
      storage.update((current) => ({ ...current, claimsJson: `${current.claimsJson}B` })),
    ]);

    await expect(storage.load()).resolves.toMatchObject({ claimsJson: "[]AB" });
  });
});

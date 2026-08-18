import { describe, expect, it } from "vitest";
import {
  createPayerCrashConsistentStorage,
  PAYER_ONCHAIN_DURABLE_NAMESPACE,
} from "../../apps/payer-mobile/src/payer-crash-storage.js";
import type { PersistedOnchainSession } from "../../apps/payer-mobile/src/onchain-provisioning.js";
import { MemoryDurableStorage, testGeneration } from "./mobile-storage-memory.js";

const first: PersistedOnchainSession = {
  provisioningJson: "provisioning-v1",
  branchStateJson: "branch-v1",
  deviceSecretHex: "11".repeat(32),
};

const second: PersistedOnchainSession = {
  provisioningJson: "provisioning-v2",
  branchStateJson: "branch-v2",
  deviceSecretHex: "22".repeat(32),
};

describe("payer crash-consistent storage adapter", () => {
  it("uses legacy state only when no durable generation exists", async () => {
    const memory = new MemoryDurableStorage();
    const storage = createPayerCrashConsistentStorage(memory, { load: async () => first }, () => testGeneration(1));

    await expect(storage.load()).resolves.toEqual(first);
    await storage.commit(second);
    await expect(storage.load()).resolves.toEqual(second);
  });

  it("never falls back to legacy state after durable corruption", async () => {
    const memory = new MemoryDurableStorage();
    const storage = createPayerCrashConsistentStorage(memory, { load: async () => first }, () => testGeneration(1));
    await storage.commit(second);
    memory.removeWithoutBoundary(
      "protected",
      `${PAYER_ONCHAIN_DURABLE_NAMESPACE}.generation.${testGeneration(1)}.device-secret`,
    );

    await expect(storage.load()).rejects.toThrow(/durável do pagador inválido/i);
  });

  it("retains the prior authoritative session at every interrupted update boundary", async () => {
    for (let failAt = 1; failAt <= 6; failAt += 1) {
      const memory = new MemoryDurableStorage();
      let generation = 0;
      const storage = createPayerCrashConsistentStorage(
        memory,
        { load: async () => ({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null }) },
        () => testGeneration(++generation),
      );
      await storage.commit(first);
      memory.resetFault(failAt);
      await expect(storage.commit(second)).rejects.toThrow(`fault-${failAt}`);
      memory.resetFault(null);
      await expect(storage.load()).resolves.toEqual(first);
    }
  });

  it("serializes concurrent payer commits instead of interleaving generations", async () => {
    const memory = new MemoryDurableStorage();
    let generation = 0;
    const storage = createPayerCrashConsistentStorage(
      memory,
      { load: async () => ({ provisioningJson: null, branchStateJson: null, deviceSecretHex: null }) },
      () => testGeneration(++generation),
    );

    await Promise.all([storage.commit(first), storage.commit(second)]);

    await expect(storage.load()).resolves.toEqual(second);
  });
});

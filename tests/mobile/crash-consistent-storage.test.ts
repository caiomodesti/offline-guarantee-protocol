import { describe, expect, it } from "vitest";
import {
  createCrashConsistentStore,
} from "@ogp/mobile-storage";
import { MemoryDurableStorage, testGeneration } from "./mobile-storage-memory.js";

function fixture(storage: MemoryDurableStorage, generations: readonly string[]) {
  let index = 0;
  return createCrashConsistentStore({
    namespace: "ogp.test.storage.v1",
    components: [
      { name: "claims", area: "public" },
      { name: "challenge", area: "public" },
      { name: "secret", area: "protected" },
    ],
    storage,
    nextGeneration: () => generations[index++] ?? testGeneration(0xff),
  });
}

const first = { claims: "claims-v1", challenge: "challenge-v1", secret: "secret-v1" };
const second = { claims: "claims-v2", challenge: "challenge-v2", secret: "secret-v2" };

describe("crash-consistent mobile storage", () => {
  it("publishes only a complete committed generation", async () => {
    const memory = new MemoryDurableStorage();
    const store = fixture(memory, [testGeneration(1)]);
    const committed = await store.commit(first);
    const loaded = await store.load();

    expect(committed).toEqual({ generation: testGeneration(1), cleanupPending: false });
    expect(loaded).toEqual({
      status: "committed",
      generation: testGeneration(1),
      values: first,
      recovery: "clean",
      cleanupPending: false,
    });
    expect(memory.read("public", "ogp.test.storage.v1.transaction.prepared")).toBeNull();
  });

  it("gives an interrupted initial write zero authority at every pre-commit boundary", async () => {
    for (let failAt = 1; failAt <= 6; failAt += 1) {
      const memory = new MemoryDurableStorage();
      const store = fixture(memory, [testGeneration(failAt)]);
      memory.resetFault(failAt);
      await expect(store.commit(first)).rejects.toThrow(`fault-${failAt}`);
      memory.resetFault(null);
      const loaded = await store.load();
      expect(loaded.status, `boundary ${failAt}`).toBe("empty");
    }
  });

  it("keeps the previous committed generation at every interrupted update boundary", async () => {
    for (let failAt = 1; failAt <= 6; failAt += 1) {
      const memory = new MemoryDurableStorage();
      const store = fixture(memory, [testGeneration(1), testGeneration(failAt + 1)]);
      await store.commit(first);
      memory.resetFault(failAt);
      await expect(store.commit(second)).rejects.toThrow(`fault-${failAt}`);
      memory.resetFault(null);
      const loaded = await store.load();
      expect(loaded.status, `boundary ${failAt}`).toBe("committed");
      if (loaded.status === "committed") expect(loaded.values).toEqual(first);
    }
  });

  it("treats both post-commit finalization failures as success, preventing economic replay", async () => {
    for (const failAt of [7, 8]) {
      const memory = new MemoryDurableStorage();
      const store = fixture(memory, [testGeneration(failAt)]);
      memory.resetFault(failAt);
      await expect(store.commit(first)).resolves.toEqual({ generation: testGeneration(failAt), cleanupPending: true });
      memory.resetFault(null);
      const loaded = await store.load();
      expect(loaded).toMatchObject({ status: "committed", values: first, recovery: "completed-commit" });
    }
  });

  it("rejects cross-generation component mixing", async () => {
    const memory = new MemoryDurableStorage();
    const store = fixture(memory, [testGeneration(1), testGeneration(2)]);
    await store.commit(first);
    const oldComponent = memory.read("public", `ogp.test.storage.v1.generation.${testGeneration(1)}.claims`);
    await store.commit(second);
    if (oldComponent === null) throw new Error("fixture component missing");
    memory.writeWithoutBoundary("public", `ogp.test.storage.v1.generation.${testGeneration(2)}.claims`, oldComponent);

    await expect(store.load()).resolves.toMatchObject({ status: "corrupt", reason: expect.stringMatching(/geração comprometida/i) });
  });

  it("rejects payload mutation even when the generation label is unchanged", async () => {
    const memory = new MemoryDurableStorage();
    const store = fixture(memory, [testGeneration(1)]);
    await store.commit(first);
    const key = `ogp.test.storage.v1.generation.${testGeneration(1)}.claims`;
    const raw = memory.read("public", key);
    if (raw === null) throw new Error("fixture component missing");
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    memory.writeWithoutBoundary("public", key, JSON.stringify({ ...envelope, payload: "mutated" }));

    await expect(store.load()).resolves.toMatchObject({ status: "corrupt", reason: expect.stringMatching(/SHA-256/) });
  });

  it("rejects rollback of only the public committed pointer", async () => {
    const memory = new MemoryDurableStorage();
    const store = fixture(memory, [testGeneration(1), testGeneration(2)]);
    await store.commit(first);
    const firstPointer = memory.read("public", "ogp.test.storage.v1.transaction.committed");
    await store.commit(second);
    if (firstPointer === null) throw new Error("first committed pointer missing");
    memory.writeWithoutBoundary("public", "ogp.test.storage.v1.transaction.committed", firstPointer);

    await expect(store.load()).resolves.toMatchObject({ status: "corrupt", reason: expect.stringMatching(/journal protegido/i) });
  });

  it("rejects deletion of the public pointer while a protected current generation exists", async () => {
    const memory = new MemoryDurableStorage();
    const store = fixture(memory, [testGeneration(1)]);
    await store.commit(first);
    memory.removeWithoutBoundary("public", "ogp.test.storage.v1.transaction.committed");

    await expect(store.load()).resolves.toMatchObject({ status: "corrupt", reason: expect.stringMatching(/ponteiro público/i) });
  });

  it("gives a public-only snapshot zero authority without the protected journal", async () => {
    const memory = new MemoryDurableStorage();
    const store = fixture(memory, [testGeneration(1)]);
    await store.commit(first);
    memory.removeWithoutBoundary("protected", "ogp.test.storage.v1.transaction.protected-journal");

    await expect(store.load()).resolves.toMatchObject({ status: "corrupt", reason: expect.stringMatching(/journal protegido ausente/i) });
  });
});

import { createCrashConsistentStore, type DurableStoragePort } from "@ogp/mobile-storage";

const HEX_32 = /^[0-9a-f]{64}$/;

export interface MerchantDurableSnapshot {
  readonly deviceSecretHex: string;
  readonly claimsJson: string;
  readonly outstandingChallengeJson: string | null;
}

export interface LegacyMerchantStoragePort {
  readonly load: () => Promise<{
    readonly deviceSecretHex: string | null;
    readonly claimsJson: string | null;
    readonly outstandingChallengeJson: string | null;
  }>;
}

export interface MerchantCrashConsistentStorage {
  readonly load: () => Promise<MerchantDurableSnapshot | null>;
  readonly initialize: (deviceSecretHex: string) => Promise<MerchantDurableSnapshot>;
  readonly update: (mutate: (current: MerchantDurableSnapshot) => MerchantDurableSnapshot) => Promise<MerchantDurableSnapshot>;
}

function validateSnapshot(snapshot: MerchantDurableSnapshot): MerchantDurableSnapshot {
  if (!HEX_32.test(snapshot.deviceSecretHex)) throw new Error("chave protegida do merchant deve conter exatamente 32 bytes hexadecimais");
  if (typeof snapshot.claimsJson !== "string") throw new Error("snapshot de claims inválido");
  if (snapshot.outstandingChallengeJson !== null && typeof snapshot.outstandingChallengeJson !== "string") throw new Error("snapshot de pedido pendente inválido");
  return snapshot;
}

export function createMerchantCrashConsistentStorage(
  namespace: string,
  storage: DurableStoragePort,
  legacy: LegacyMerchantStoragePort,
  nextGeneration?: () => string | Uint8Array,
): MerchantCrashConsistentStorage {
  const durable = createCrashConsistentStore({
    namespace,
    components: [
      { name: "claims", area: "public" },
      { name: "outstanding-challenge", area: "public" },
      { name: "device-secret", area: "protected" },
    ],
    storage,
    ...(nextGeneration === undefined ? {} : { nextGeneration }),
  });
  let tail: Promise<void> = Promise.resolve();

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function commit(snapshot: MerchantDurableSnapshot): Promise<void> {
    const valid = validateSnapshot(snapshot);
    await durable.commit({
      claims: valid.claimsJson,
      "outstanding-challenge": valid.outstandingChallengeJson ?? "null",
      "device-secret": valid.deviceSecretHex,
    });
  }

  async function rawLoad(): Promise<MerchantDurableSnapshot | null> {
    const result = await durable.load();
    if (result.status === "corrupt") throw new Error(`Armazenamento durável do merchant inválido: ${result.reason}`);
    if (result.status === "committed") {
      const outstanding = result.values["outstanding-challenge"];
      if (outstanding === undefined) throw new Error("Snapshot durável do merchant não contém pedido pendente");
      return validateSnapshot({
        deviceSecretHex: result.values["device-secret"] ?? "",
        claimsJson: result.values.claims ?? "",
        outstandingChallengeJson: outstanding === "null" ? null : outstanding,
      });
    }

    const old = await legacy.load();
    const publicPresent = old.claimsJson !== null || old.outstandingChallengeJson !== null;
    if (old.deviceSecretHex === null) {
      if (publicPresent) throw new Error("Estado público legado existe sem a chave protegida do merchant");
      return null;
    }
    const migrated = validateSnapshot({
      deviceSecretHex: old.deviceSecretHex,
      claimsJson: old.claimsJson ?? "[]",
      outstandingChallengeJson: old.outstandingChallengeJson,
    });
    await commit(migrated);
    return migrated;
  }

  return {
    load: () => exclusive(rawLoad),
    initialize: (deviceSecretHex) => exclusive(async () => {
      const existing = await rawLoad();
      if (existing !== null) return existing;
      const initial = validateSnapshot({ deviceSecretHex, claimsJson: "[]", outstandingChallengeJson: null });
      await commit(initial);
      return initial;
    }),
    update: (mutate) => exclusive(async () => {
      const current = await rawLoad();
      if (current === null) throw new Error("armazenamento do merchant ainda não foi inicializado");
      const next = validateSnapshot(mutate(current));
      await commit(next);
      return next;
    }),
  };
}

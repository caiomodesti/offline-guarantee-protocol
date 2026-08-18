import { createCrashConsistentStore, type DurableStoragePort } from "@ogp/mobile-storage";
import type { PersistedOnchainSession } from "./onchain-provisioning.js";
import type { PayerRecoveryStoragePort, PayerRecoveryStorageSnapshot } from "./onchain-recovery-controller.js";

export const PAYER_ONCHAIN_DURABLE_NAMESPACE = "ogp.payer.onchain.storage.v1";

export interface LegacyPayerStoragePort {
  readonly load: () => Promise<PayerRecoveryStorageSnapshot>;
}

export function createPayerCrashConsistentStorage(
  storage: DurableStoragePort,
  legacy: LegacyPayerStoragePort,
  nextGeneration?: () => string | Uint8Array,
): PayerRecoveryStoragePort {
  const durable = createCrashConsistentStore({
    namespace: PAYER_ONCHAIN_DURABLE_NAMESPACE,
    components: [
      { name: "branch-state", area: "public" },
      { name: "provisioning", area: "public" },
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

  return {
    load: () => exclusive(async () => {
      const result = await durable.load();
      if (result.status === "corrupt") throw new Error(`Armazenamento durável do pagador inválido: ${result.reason}`);
      if (result.status === "empty") return legacy.load();
      return {
        provisioningJson: result.values.provisioning ?? null,
        branchStateJson: result.values["branch-state"] ?? null,
        deviceSecretHex: result.values["device-secret"] ?? null,
      };
    }),
    commit: (snapshot: PersistedOnchainSession) => exclusive(async () => {
      await durable.commit({
        "branch-state": snapshot.branchStateJson,
        provisioning: snapshot.provisioningJson,
        "device-secret": snapshot.deviceSecretHex,
      });
    }),
  };
}

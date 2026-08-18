import { generateChallenge, hashSha256 } from "@ogp/crypto";

const FORMAT_VERSION = 1;
const GENERATION = /^[0-9a-f]{64}$/;
const COMPONENT_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export type StorageArea = "public" | "protected";

export interface DurableStoragePort {
  readonly get: (area: StorageArea, key: string) => Promise<string | null>;
  readonly set: (area: StorageArea, key: string, value: string) => Promise<void>;
  readonly remove: (area: StorageArea, key: string) => Promise<void>;
}

export interface DurableComponentDefinition {
  readonly name: string;
  readonly area: StorageArea;
}

export type RecoveryDisposition = "clean" | "rolled-back-prepared" | "completed-commit" | "discarded-invalid-prepared";

export type DurableLoadResult =
  | { readonly status: "empty"; readonly recovery: RecoveryDisposition; readonly cleanupPending: boolean }
  | { readonly status: "committed"; readonly generation: string; readonly values: Readonly<Record<string, string>>; readonly recovery: RecoveryDisposition; readonly cleanupPending: boolean }
  | { readonly status: "corrupt"; readonly reason: string };

export interface DurableCommitResult {
  readonly generation: string;
  readonly cleanupPending: boolean;
}

export interface CrashConsistentStore {
  readonly load: () => Promise<DurableLoadResult>;
  readonly commit: (values: Readonly<Record<string, string>>) => Promise<DurableCommitResult>;
}

export interface CrashConsistentStoreOptions {
  readonly namespace: string;
  readonly components: readonly DurableComponentDefinition[];
  readonly storage: DurableStoragePort;
  readonly nextGeneration?: () => string | Uint8Array;
}

interface ManifestComponentV1 {
  readonly name: string;
  readonly area: StorageArea;
  readonly key: string;
  readonly sha256: string;
}

interface ManifestV1 {
  readonly version: 1;
  readonly namespace: string;
  readonly generation: string;
  readonly phase: "prepared" | "committed";
  readonly components: readonly ManifestComponentV1[];
}

interface ComponentEnvelopeV1 {
  readonly version: 1;
  readonly generation: string;
  readonly name: string;
  readonly payload: string;
}

interface ProtectedJournalV1 {
  readonly version: 1;
  readonly namespace: string;
  readonly currentGeneration: string | null;
  readonly pendingGeneration: string | null;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digest(value: string): string {
  return bytesToHex(hashSha256(new TextEncoder().encode(value)));
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} inválido`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw new Error(`${name} contém campos inesperados`);
}

function json(value: string, name: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value) as unknown, name);
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith(name)) throw reason;
    throw new Error(`${name} não contém JSON válido`);
  }
}

function generation(value: string | Uint8Array): string {
  const encoded = typeof value === "string" ? value : bytesToHex(value);
  if (!GENERATION.test(encoded)) throw new Error("generation ID deve conter exatamente 32 bytes hexadecimais");
  return encoded;
}

function componentKey(namespace: string, generationId: string, name: string): string {
  return `${namespace}.generation.${generationId}.${name}`;
}

function parseManifest(raw: string, namespace: string, definitions: readonly DurableComponentDefinition[], expectedPhase: ManifestV1["phase"]): ManifestV1 {
  const parsed = json(raw, "manifesto durável");
  exactKeys(parsed, ["version", "namespace", "generation", "phase", "components"], "manifesto durável");
  if (parsed.version !== FORMAT_VERSION || parsed.namespace !== namespace || parsed.phase !== expectedPhase || typeof parsed.generation !== "string" || !GENERATION.test(parsed.generation)) {
    throw new Error("manifesto durável possui versão, namespace, fase ou geração inválida");
  }
  if (!Array.isArray(parsed.components) || parsed.components.length !== definitions.length) throw new Error("manifesto durável possui componentes inválidos");
  const components = parsed.components.map((entry, index): ManifestComponentV1 => {
    const definition = definitions[index];
    if (definition === undefined) throw new Error("manifesto durável possui componente excedente");
    const item = object(entry, "componente do manifesto");
    exactKeys(item, ["name", "area", "key", "sha256"], "componente do manifesto");
    const expectedKey = componentKey(namespace, parsed.generation as string, definition.name);
    if (item.name !== definition.name || item.area !== definition.area || item.key !== expectedKey || typeof item.sha256 !== "string" || !GENERATION.test(item.sha256)) {
      throw new Error("componente do manifesto não corresponde ao layout configurado");
    }
    return { name: definition.name, area: definition.area, key: expectedKey, sha256: item.sha256 };
  });
  return { version: 1, namespace, generation: parsed.generation, phase: expectedPhase, components };
}

function parseComponent(raw: string, manifest: ManifestV1, expected: ManifestComponentV1): string {
  const parsed = json(raw, `componente durável ${expected.name}`);
  exactKeys(parsed, ["version", "generation", "name", "payload"], `componente durável ${expected.name}`);
  if (parsed.version !== FORMAT_VERSION || parsed.generation !== manifest.generation || parsed.name !== expected.name || typeof parsed.payload !== "string") {
    throw new Error(`componente durável ${expected.name} não corresponde à geração comprometida`);
  }
  if (digest(parsed.payload) !== expected.sha256) throw new Error(`componente durável ${expected.name} falhou na verificação SHA-256`);
  return parsed.payload;
}

function nullableGeneration(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !GENERATION.test(value)) throw new Error(`${name} inválida`);
  return value;
}

function parseProtectedJournal(raw: string, namespace: string): ProtectedJournalV1 {
  const parsed = json(raw, "journal protegido");
  exactKeys(parsed, ["version", "namespace", "currentGeneration", "pendingGeneration"], "journal protegido");
  if (parsed.version !== FORMAT_VERSION || parsed.namespace !== namespace) throw new Error("journal protegido possui versão ou namespace inválido");
  const currentGeneration = nullableGeneration(parsed.currentGeneration, "geração atual do journal");
  const pendingGeneration = nullableGeneration(parsed.pendingGeneration, "geração pendente do journal");
  if (currentGeneration !== null && currentGeneration === pendingGeneration) throw new Error("journal protegido repete a geração atual como pendente");
  return { version: 1, namespace, currentGeneration, pendingGeneration };
}

function validateDefinitions(namespace: string, definitions: readonly DurableComponentDefinition[]): void {
  if (namespace.length === 0 || namespace.length > 240 || /\s/.test(namespace)) throw new Error("namespace durável inválido");
  if (definitions.length === 0) throw new Error("ao menos um componente durável é obrigatório");
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!COMPONENT_NAME.test(definition.name)) throw new Error(`nome de componente durável inválido: ${definition.name}`);
    if (names.has(definition.name)) throw new Error(`componente durável duplicado: ${definition.name}`);
    names.add(definition.name);
  }
}

async function bestEffortRemove(storage: DurableStoragePort, area: StorageArea, key: string): Promise<boolean> {
  try {
    await storage.remove(area, key);
    return false;
  } catch {
    return true;
  }
}

async function bestEffortSet(storage: DurableStoragePort, area: StorageArea, key: string, value: string): Promise<boolean> {
  try {
    await storage.set(area, key, value);
    return false;
  } catch {
    return true;
  }
}

export function createCrashConsistentStore(options: CrashConsistentStoreOptions): CrashConsistentStore {
  const definitions = [...options.components];
  validateDefinitions(options.namespace, definitions);
  const preparedKey = `${options.namespace}.transaction.prepared`;
  const committedKey = `${options.namespace}.transaction.committed`;
  const protectedJournalKey = `${options.namespace}.transaction.protected-journal`;
  const nextGeneration = options.nextGeneration ?? (() => generateChallenge());

  const load = async (): Promise<DurableLoadResult> => {
      const [committedRaw, preparedRaw, protectedJournalRaw] = await Promise.all([
        options.storage.get("public", committedKey),
        options.storage.get("public", preparedKey),
        options.storage.get("protected", protectedJournalKey),
      ]);
      let protectedJournal: ProtectedJournalV1 | null = null;
      if (protectedJournalRaw !== null) {
        try {
          protectedJournal = parseProtectedJournal(protectedJournalRaw, options.namespace);
        } catch (reason) {
          return { status: "corrupt", reason: reason instanceof Error ? reason.message : "journal protegido inválido" };
        }
      }

      if (committedRaw === null) {
        if (protectedJournal?.currentGeneration !== null && protectedJournal?.currentGeneration !== undefined) {
          return { status: "corrupt", reason: "ponteiro público comprometido ausente para a geração protegida atual" };
        }
        if (preparedRaw === null && protectedJournal === null) return { status: "empty", recovery: "clean", cleanupPending: false };
        let recovery: RecoveryDisposition = "rolled-back-prepared";
        if (preparedRaw !== null) {
          try {
            const prepared = parseManifest(preparedRaw, options.namespace, definitions, "prepared");
            if (protectedJournal?.pendingGeneration !== null && protectedJournal?.pendingGeneration !== undefined && prepared.generation !== protectedJournal.pendingGeneration) {
              return { status: "corrupt", reason: "manifesto preparado diverge da geração protegida pendente" };
            }
          } catch (reason) {
            if (reason instanceof Error && reason.message.includes("diverge")) return { status: "corrupt", reason: reason.message };
            recovery = "discarded-invalid-prepared";
          }
        }
        let cleanupPending = false;
        if (protectedJournalRaw !== null) cleanupPending = await bestEffortRemove(options.storage, "protected", protectedJournalKey) || cleanupPending;
        if (preparedRaw !== null) cleanupPending = await bestEffortRemove(options.storage, "public", preparedKey) || cleanupPending;
        return { status: "empty", recovery, cleanupPending };
      }

      if (protectedJournal === null) return { status: "corrupt", reason: "journal protegido ausente para o ponteiro público comprometido" };
      let committed: ManifestV1;
      try {
        committed = parseManifest(committedRaw, options.namespace, definitions, "committed");
      } catch (reason) {
        return { status: "corrupt", reason: reason instanceof Error ? reason.message : "manifesto comprometido inválido" };
      }

      const isCurrent = protectedJournal.currentGeneration === committed.generation;
      const isPendingCommit = protectedJournal.pendingGeneration === committed.generation;
      if (!isCurrent && !isPendingCommit) {
        return { status: "corrupt", reason: "geração pública comprometida diverge do journal protegido" };
      }

      const values: Record<string, string> = {};
      try {
        for (const component of committed.components) {
          const raw = await options.storage.get(component.area, component.key);
          if (raw === null) throw new Error(`componente durável ${component.name} ausente`);
          values[component.name] = parseComponent(raw, committed, component);
        }
      } catch (reason) {
        return { status: "corrupt", reason: reason instanceof Error ? reason.message : "snapshot durável inválido" };
      }

      let recovery: RecoveryDisposition = "clean";
      let cleanupPending = false;
      if (isPendingCommit) {
        recovery = "completed-commit";
        const finalized: ProtectedJournalV1 = {
          version: 1,
          namespace: options.namespace,
          currentGeneration: committed.generation,
          pendingGeneration: null,
        };
        cleanupPending = await bestEffortSet(options.storage, "protected", protectedJournalKey, JSON.stringify(finalized)) || cleanupPending;
      } else if (protectedJournal.pendingGeneration !== null) {
        recovery = "rolled-back-prepared";
        const rolledBack: ProtectedJournalV1 = {
          version: 1,
          namespace: options.namespace,
          currentGeneration: committed.generation,
          pendingGeneration: null,
        };
        cleanupPending = await bestEffortSet(options.storage, "protected", protectedJournalKey, JSON.stringify(rolledBack)) || cleanupPending;
      }
      if (preparedRaw !== null) {
        try {
          const prepared = parseManifest(preparedRaw, options.namespace, definitions, "prepared");
          if (recovery === "clean") recovery = prepared.generation === committed.generation ? "completed-commit" : "rolled-back-prepared";
        } catch {
          recovery = "discarded-invalid-prepared";
        }
        cleanupPending = await bestEffortRemove(options.storage, "public", preparedKey) || cleanupPending;
      }
      return { status: "committed", generation: committed.generation, values, recovery, cleanupPending };
  };

  return {
    load,
    commit: async (values) => {
      const names = Object.keys(values).sort();
      const expected = definitions.map((definition) => definition.name).sort();
      if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error("snapshot durável não contém exatamente os componentes configurados");
      for (const name of names) if (typeof values[name] !== "string") throw new Error(`componente durável ${name} deve ser string`);

      const previous = await load();
      if (previous.status === "corrupt") throw new Error(`snapshot durável anterior inválido: ${previous.reason}`);
      const currentGeneration = previous.status === "committed" ? previous.generation : null;
      let generationId: string | null = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generation(nextGeneration());
        if (candidate !== currentGeneration) {
          generationId = candidate;
          break;
        }
      }
      if (generationId === null) throw new Error("não foi possível gerar generation ID único");

      const components = definitions.map((definition): ManifestComponentV1 => {
        const payload = values[definition.name];
        if (payload === undefined) throw new Error(`componente durável ${definition.name} ausente`);
        return {
          name: definition.name,
          area: definition.area,
          key: componentKey(options.namespace, generationId as string, definition.name),
          sha256: digest(payload),
        };
      });
      const prepared: ManifestV1 = { version: 1, namespace: options.namespace, generation: generationId, phase: "prepared", components };
      await options.storage.set("public", preparedKey, JSON.stringify(prepared));
      const pending: ProtectedJournalV1 = {
        version: 1,
        namespace: options.namespace,
        currentGeneration,
        pendingGeneration: generationId,
      };
      await options.storage.set("protected", protectedJournalKey, JSON.stringify(pending));
      for (const component of components) {
        const payload = values[component.name];
        if (payload === undefined) throw new Error(`componente durável ${component.name} ausente`);
        const envelope: ComponentEnvelopeV1 = { version: 1, generation: generationId, name: component.name, payload };
        await options.storage.set(component.area, component.key, JSON.stringify(envelope));
      }
      const committed: ManifestV1 = { ...prepared, phase: "committed" };
      await options.storage.set("public", committedKey, JSON.stringify(committed));
      const finalized: ProtectedJournalV1 = {
        version: 1,
        namespace: options.namespace,
        currentGeneration: generationId,
        pendingGeneration: null,
      };
      let cleanupPending = await bestEffortSet(options.storage, "protected", protectedJournalKey, JSON.stringify(finalized));
      cleanupPending = await bestEffortRemove(options.storage, "public", preparedKey) || cleanupPending;
      return { generation: generationId, cleanupPending };
    },
  };
}

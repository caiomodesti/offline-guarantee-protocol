import type { PayerSessionRuntime } from "./payer-runtime";

export type PayerRuntimeMode = "on-chain" | "development-fixture";

export type PayerRuntimeBootstrap =
  | {
      readonly kind: "ready";
      readonly mode: "development-fixture";
      readonly runtime: PayerSessionRuntime;
    }
  | {
      readonly kind: "online-recovery-required";
      readonly mode: "on-chain";
    };

/**
 * Production defaults to the on-chain path. The Sprint 7 fixture is available
 * only when a demonstration build opts in explicitly at build time.
 */
export function payerRuntimeMode(value: string | undefined): PayerRuntimeMode {
  if (value === undefined || value === "" || value === "on-chain") return "on-chain";
  if (value === "development-fixture") return "development-fixture";
  throw new Error(`modo de execução do pagador não reconhecido: ${value}`);
}

/**
 * This boundary never invents an on-chain session. Until confirmed recovery
 * material has been loaded, the only valid production outcome is fail-closed.
 */
export function bootstrapPayerRuntime(
  value: string | undefined,
  loadFixture?: () => PayerSessionRuntime,
): PayerRuntimeBootstrap {
  const mode = payerRuntimeMode(value);
  if (mode === "on-chain") return { kind: "online-recovery-required", mode };
  if (loadFixture === undefined) throw new Error("a entrada de demonstração não forneceu uma fixture explícita");
  return { kind: "ready", mode, runtime: loadFixture() };
}

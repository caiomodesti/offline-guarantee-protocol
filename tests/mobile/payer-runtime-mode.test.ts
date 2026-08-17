import { describe, expect, it, vi } from "vitest";
import { encodeSessionCertificate } from "@ogp/canonical-codec";
import { loadDevelopmentSession } from "../../apps/payer-mobile/src/dev-session.js";
import { bootstrapPayerRuntime, payerRuntimeMode } from "../../apps/payer-mobile/src/runtime-mode.js";

describe("payer runtime mode boundary", () => {
  it("defaults to the fail-closed on-chain path", () => {
    const forbiddenFixtureLoad = vi.fn(() => { throw new Error("fixture must not load"); });
    expect(payerRuntimeMode(undefined)).toBe("on-chain");
    expect(payerRuntimeMode("")).toBe("on-chain");
    expect(bootstrapPayerRuntime(undefined, forbiddenFixtureLoad)).toEqual({
      kind: "online-recovery-required",
      mode: "on-chain",
    });
    expect(forbiddenFixtureLoad).not.toHaveBeenCalled();
  });

  it("loads the canonical Sprint 7 fixture only after explicit opt-in", () => {
    expect(() => bootstrapPayerRuntime("development-fixture")).toThrow(/fixture explícita/);
    const bootstrap = bootstrapPayerRuntime("development-fixture", loadDevelopmentSession);
    expect(bootstrap.kind).toBe("ready");
    if (bootstrap.kind !== "ready") throw new Error("fixture bootstrap unexpectedly failed");
    expect(encodeSessionCertificate(bootstrap.runtime.sessionCertificate)).toHaveLength(554);
  });

  it("rejects misspelled or unknown modes instead of falling back to a fixture", () => {
    expect(() => payerRuntimeMode("fixture")).toThrow(/não reconhecido/);
    expect(() => payerRuntimeMode("production")).toThrow(/não reconhecido/);
  });
});

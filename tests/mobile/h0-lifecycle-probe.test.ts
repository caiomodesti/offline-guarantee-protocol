import { describe, expect, it } from "vitest";
import {
  H0_PUBLIC_COPY_PREFIX,
  H0_PUBLIC_COPY_MAX_QR_BYTES,
  createH0ProbeMaterial,
  evaluateH0Snapshot,
  hashH0PublicCopy,
  parseH0PublicCopy,
} from "../../apps/payer-mobile/src/h0-lifecycle-probe.js";

describe("H0 lifecycle probe", () => {
  it("grants offline authority only to the complete protected tuple", async () => {
    const material = createH0ProbeMaterial();
    const result = await evaluateH0Snapshot({
      provisioningJson: material.persisted.provisioningJson,
      branchStateJson: material.persisted.branchStateJson,
      deviceSecretHex: material.persisted.deviceSecretHex,
    });
    expect(result).toMatchObject({ outcome: "offline-ready", localValidationError: null, economicAuthorityAvailable: true });
  });

  it("fails closed when only the protected key is lost", async () => {
    const material = createH0ProbeMaterial();
    const result = await evaluateH0Snapshot({
      provisioningJson: material.persisted.provisioningJson,
      branchStateJson: material.persisted.branchStateJson,
      deviceSecretHex: null,
    });
    expect(result.outcome).toBe("online-recovery-required");
    expect(result.localValidationError).toMatch(/somente parte/);
    expect(result.economicAuthorityAvailable).toBe(false);
  });

  it("fails closed after restoring only AsyncStorage-equivalent public state", async () => {
    const material = createH0ProbeMaterial();
    const result = await evaluateH0Snapshot({
      provisioningJson: material.publicCopy.provisioningJson,
      branchStateJson: material.publicCopy.branchStateJson,
      deviceSecretHex: null,
    });
    expect(result.outcome).toBe("online-recovery-required");
    expect(result.economicAuthorityAvailable).toBe(false);
  });

  it("copies exact public bytes without transferring device authority", async () => {
    const source = createH0ProbeMaterial();
    expect(new TextEncoder().encode(`${H0_PUBLIC_COPY_PREFIX}${source.publicCopyJson}`).length).toBeLessThanOrEqual(H0_PUBLIC_COPY_MAX_QR_BYTES);
    expect(source.publicCopyJson).not.toContain(source.persisted.deviceSecretHex);
    const imported = parseH0PublicCopy(`${H0_PUBLIC_COPY_PREFIX}${source.publicCopyJson}`);
    expect(hashH0PublicCopy(imported)).toBe(source.publicCopyHash);
    const result = await evaluateH0Snapshot({
      provisioningJson: imported.provisioningJson,
      branchStateJson: imported.branchStateJson,
      deviceSecretHex: null,
    });
    expect(result.economicAuthorityAvailable).toBe(false);
  });

  it("rejects a copied public state paired with another device secret", async () => {
    const material = createH0ProbeMaterial();
    const result = await evaluateH0Snapshot({
      provisioningJson: material.publicCopy.provisioningJson,
      branchStateJson: material.publicCopy.branchStateJson,
      deviceSecretHex: "03".repeat(32),
    });
    expect(result.outcome).toBe("online-recovery-required");
    expect(result.localValidationError).toMatch(/chave protegida/);
    expect(result.economicAuthorityAvailable).toBe(false);
  });

  it("rejects unknown fields in the physical copy envelope", () => {
    const material = createH0ProbeMaterial();
    expect(() => parseH0PublicCopy(JSON.stringify({ ...material.publicCopy, deviceSecretHex: material.persisted.deviceSecretHex })))
      .toThrow(/campos inesperados/);
  });

  it("rejects oversized scanner input before parsing", () => {
    expect(() => parseH0PublicCopy("x".repeat(H0_PUBLIC_COPY_MAX_QR_BYTES + 1))).toThrow(/limite do QR/);
  });
});

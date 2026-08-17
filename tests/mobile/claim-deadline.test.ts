import { describe, expect, it } from "vitest";
import { presentClaimDeadline } from "../../apps/merchant-mobile/src/claim-deadline.js";

describe("merchant claim deadline presentation", () => {
  const now = 1_800_000_000_000;

  it("separates normal, attention, urgent and locally apparent expiry", () => {
    expect(presentClaimDeadline(1_800_030_000n, now).urgency).toBe("normal");
    expect(presentClaimDeadline(1_800_021_600n, now).urgency).toBe("attention");
    expect(presentClaimDeadline(1_800_003_600n, now).urgency).toBe("urgent");
    expect(presentClaimDeadline(1_799_999_999n, now).urgency).toBe("apparently-expired");
  });

  it("describes every result as a local-clock observation, not eligibility proof", () => {
    for (const seconds of [1_800_030_000n, 1_800_020_000n, 1_800_003_000n, 1_799_999_000n]) {
      expect(presentClaimDeadline(seconds, now).message).toMatch(/relógio deste aparelho/i);
    }
  });

  it("rejects unrenderable deadlines and invalid local clocks", () => {
    expect(() => presentClaimDeadline(-1n, now)).toThrow(/intervalo/);
    expect(() => presentClaimDeadline(1_800_000_000n, Number.NaN)).toThrow(/relógio local/);
  });
});

import { describe, expect, it } from "vitest";
import { encodeSessionCertificate } from "@ogp/canonical-codec";
import { derivePublicKey } from "@ogp/crypto";
import { equalBytes } from "@ogp/shared-types";
import { validateCertificateChain } from "@ogp/credentials";
import { hexToBytes, loadDevelopmentSession } from "../../apps/payer-mobile/src/dev-session.js";

describe("payer development bootstrap", () => {
  it("restores a canonical 554-byte certificate bound to the device secret", () => {
    const runtime = loadDevelopmentSession();

    expect(encodeSessionCertificate(runtime.sessionCertificate)).toHaveLength(554);
    expect(equalBytes(derivePublicKey(hexToBytes(runtime.deviceSecretHex)), runtime.sessionCertificate.devicePublicKey)).toBe(true);
    expect(() => validateCertificateChain(runtime.trustContext, runtime.sessionCertificate, runtime.deviceAuthorization)).not.toThrow();
    expect(runtime.initialParent.remaining).toBe(runtime.sessionCertificate.branchSpendingLimit);
  });
});

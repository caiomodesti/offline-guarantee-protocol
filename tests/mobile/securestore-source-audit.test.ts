import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const secureStoreRoot = resolve(root, "apps", "payer-mobile", "node_modules", "expo-secure-store");
const aesPath = resolve(secureStoreRoot, "android", "src", "main", "java", "expo", "modules", "securestore", "encryptors", "AESEncryptor.kt");
const optionsPath = resolve(secureStoreRoot, "android", "src", "main", "java", "expo", "modules", "securestore", "SecureStoreOptions.kt");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

describe("locked Expo SecureStore Android assumptions", () => {
  it("pins the audited AES wrapper implementation", () => {
    const packageJson = readFileSync(resolve(secureStoreRoot, "package.json"), "utf8");
    const aes = readFileSync(aesPath, "utf8");
    const options = readFileSync(optionsPath, "utf8");

    expect(JSON.parse(packageJson).version).toBe("57.0.1");
    expect(sha256(aes)).toBe("D3A86DE25C64935E84B6999101556B0E9F8BC6C90CE7600C421125B3E18AA3F4");
    expect(aes).toContain("AES_KEY_SIZE_BITS = 256");
    expect(aes).toContain('AES_CIPHER = "AES/GCM/NoPadding"');
    expect(aes).toContain(".setUserAuthenticationRequired(options.requireAuthentication)");
    expect(options).toContain("requireAuthentication: Boolean = false");
    expect(aes).not.toMatch(/setIsStrongBoxBacked|setAttestationChallenge|getSecurityLevel|isInsideSecureHardware/);
  });

  it("records that production does not currently request user authentication", () => {
    const payer = readFileSync(resolve(root, "apps", "payer-mobile", "App.tsx"), "utf8");
    const merchant = readFileSync(resolve(root, "apps", "merchant-mobile", "App.tsx"), "utf8");

    expect(payer).not.toContain("requireAuthentication");
    expect(merchant).not.toContain("requireAuthentication");
  });
});

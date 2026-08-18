import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = readFileSync(resolve(root, "spikes", "android-keystore-probe", "AndroidManifest.xml"), "utf8");
const source = readFileSync(resolve(root, "spikes", "android-keystore-probe", "src", "protocol", "ogp", "h2probe", "ProbeActivity.java"), "utf8");
const harness = readFileSync(resolve(root, "scripts", "h2-android-keystore-probe.ps1"), "utf8");

describe("isolated H2 Android Keystore capability probe", () => {
  it("has no network, identifier or backup authority", () => {
    expect(manifest).not.toContain("android.permission.INTERNET");
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:debuggable="false"');
    expect(source).not.toMatch(/ANDROID_ID|Build\.SERIAL|getImei|getDeviceId|certificate\.getEncoded/);
    expect(source).toContain("OGP_H2_JSON_B64=");
    expect(source).toContain('result.put("network_permission", false)');
    expect(source).toContain('result.put("protocol_effect", "none")');
  });

  it("measures rather than assumes secure hardware", () => {
    expect(source).toContain("getSecurityLevel()");
    expect(source).toContain("FEATURE_STRONGBOX_KEYSTORE");
    expect(source).toContain("setIsStrongBoxBacked(true)");
    expect(source).toContain("getCertificateChain(alias)");
    expect(source).toContain('KeyPairGenerator.getInstance("Ed25519", PROVIDER)');
  });

  it("verifies the isolated artifact and requires an explicit physical device", () => {
    expect(harness).toContain("Require-PhysicalDevice");
    expect(harness).toContain("ro.kernel.qemu");
    expect(harness).toContain("apksigner @('verify'");
    expect(harness).toContain("aapt dump badging");
    expect(harness).toContain("aapt dump permissions");
    expect(harness).toContain('android:allowBackup');
    expect(harness).toContain('android:debuggable');
    expect(harness).toContain('"$signed.sha256"');
    expect(harness).toContain("if ([string]::IsNullOrWhiteSpace($Serial))");
    expect(harness).toContain("FromBase64String");
    expect(harness).toContain("ConvertFrom-Json");
    expect(harness).toContain("@($result.measurements).Count -ne 6");
    expect(harness).toContain("$result.device_label -ne $DeviceLabel");
    expect(harness).toContain("$result.fatal -eq $true");
    expect(harness).toContain('keystore-capabilities.json');
  });
});

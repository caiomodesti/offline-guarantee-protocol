package protocol.ogp.h2probe;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Isolated H2 measurement harness. It has no network permission, emits no raw
 * key/certificate/device identifier and never participates in OGP signing.
 */
public final class ProbeActivity extends Activity {
  private static final String TAG = "OGP_H2";
  private static final String PROVIDER = "AndroidKeyStore";
  private static final String ATTESTATION_OID = "1.3.6.1.4.1.11129.2.1.17";
  private static final byte[] TEST_MESSAGE = "OGP-H2-CAPABILITY-ONLY".getBytes(StandardCharsets.UTF_8);

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    TextView text = new TextView(this);
    text.setTextSize(14);
    text.setPadding(28, 28, 28, 28);
    text.setText("Medindo Android Keystore…");
    ScrollView scroll = new ScrollView(this);
    scroll.addView(text);
    setContentView(scroll);

    new Thread(() -> {
      String output;
      try {
        output = runProbe().toString(2);
      } catch (Throwable failure) {
        output = error(failure).toString();
      }
      final String rendered = output;
      String encoded = Base64.encodeToString(rendered.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
      Log.i(TAG, "OGP_H2_JSON_B64=" + encoded);
      runOnUiThread(() -> text.setText(rendered));
    }, "ogp-h2-keystore-probe").start();
  }

  private JSONObject runProbe() throws Exception {
    PackageManager packages = getPackageManager();
    boolean strongBoxFeature = Build.VERSION.SDK_INT >= 28
      && packages.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);

    JSONObject result = new JSONObject();
    result.put("schema", "ogp-h2-keystore-capability-v1");
    result.put("device_label", safeLabel(getIntent().getStringExtra("device_label")));
    result.put("manufacturer", Build.MANUFACTURER);
    result.put("model", Build.MODEL);
    result.put("android_release", Build.VERSION.RELEASE);
    result.put("sdk", Build.VERSION.SDK_INT);
    result.put("strongbox_feature", strongBoxFeature);
    result.put("app_attest_key_feature", packages.hasSystemFeature("android.hardware.keystore.app_attest_key"));
    result.put("device_id_attestation_feature", packages.hasSystemFeature("android.software.device_id_attestation"));
    result.put("network_permission", false);

    JSONArray measurements = new JSONArray();
    measurements.put(probeAes("ogp_h2_aes_default", false));
    measurements.put(strongBoxFeature ? probeAes("ogp_h2_aes_strongbox", true) : unsupported("aes-256-gcm-strongbox", "feature-absent"));
    measurements.put(probeP256("ogp_h2_p256_default", false));
    measurements.put(strongBoxFeature ? probeP256("ogp_h2_p256_strongbox", true) : unsupported("p256-strongbox", "feature-absent"));
    measurements.put(probeEd25519("ogp_h2_ed25519_default", false));
    measurements.put(strongBoxFeature ? probeEd25519("ogp_h2_ed25519_strongbox", true) : unsupported("ed25519-strongbox", "feature-absent"));
    result.put("measurements", measurements);
    result.put("attestation_verification", "not-performed-on-device");
    result.put("protocol_effect", "none");
    return result;
  }

  private JSONObject probeAes(String alias, boolean strongBox) {
    JSONObject result = base("aes-256-gcm", strongBox);
    try {
      delete(alias);
      KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
      )
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE);
      if (strongBox && Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(true);
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
      generator.init(builder.build());
      SecretKey key = generator.generateKey();
      SecretKeyFactory factory = SecretKeyFactory.getInstance(key.getAlgorithm(), PROVIDER);
      KeyInfo info = (KeyInfo) factory.getKeySpec(key, KeyInfo.class);

      Cipher encrypt = Cipher.getInstance("AES/GCM/NoPadding");
      encrypt.init(Cipher.ENCRYPT_MODE, key);
      byte[] ciphertext = encrypt.doFinal(TEST_MESSAGE);
      Cipher decrypt = Cipher.getInstance("AES/GCM/NoPadding");
      decrypt.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, encrypt.getIV()));
      boolean roundTrip = java.util.Arrays.equals(TEST_MESSAGE, decrypt.doFinal(ciphertext));

      result.put("supported", true);
      result.put("security_level", securityLevel(info));
      result.put("inside_secure_hardware", insideSecureHardware(info));
      result.put("round_trip", roundTrip);
      result.put("key_export_attempt", key.getEncoded() == null ? "non-exportable" : "exportable-unexpected");
    } catch (Throwable failure) {
      putFailure(result, failure);
    } finally {
      delete(alias);
    }
    return result;
  }

  private JSONObject probeP256(String alias, boolean strongBox) {
    JSONObject result = base("p256-sha256-ecdsa-attested", strongBox);
    try {
      delete(alias);
      KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
      )
        .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(TEST_MESSAGE);
      if (strongBox && Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(true);
      KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER);
      generator.initialize(builder.build());
      KeyPair pair = generator.generateKeyPair();
      KeyFactory factory = KeyFactory.getInstance(pair.getPrivate().getAlgorithm(), PROVIDER);
      KeyInfo info = (KeyInfo) factory.getKeySpec(pair.getPrivate(), KeyInfo.class);

      Signature signer = Signature.getInstance("SHA256withECDSA");
      signer.initSign(pair.getPrivate());
      signer.update(TEST_MESSAGE);
      byte[] signature = signer.sign();
      Signature verifier = Signature.getInstance("SHA256withECDSA");
      verifier.initVerify(pair.getPublic());
      verifier.update(TEST_MESSAGE);

      Certificate[] chain = keyStore().getCertificateChain(alias);
      result.put("supported", true);
      result.put("security_level", securityLevel(info));
      result.put("inside_secure_hardware", insideSecureHardware(info));
      result.put("sign_verify", verifier.verify(signature));
      result.put("key_export_attempt", pair.getPrivate().getEncoded() == null ? "non-exportable" : "exportable-unexpected");
      result.put("attestation_chain_length", chain == null ? 0 : chain.length);
      result.put("attestation_extension_present", containsAttestationExtension(chain));
    } catch (Throwable failure) {
      putFailure(result, failure);
    } finally {
      delete(alias);
    }
    return result;
  }

  private JSONObject probeEd25519(String alias, boolean strongBox) {
    JSONObject result = base("ed25519-android-keystore-experimental", strongBox);
    try {
      delete(alias);
      KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY
      ).setDigests(KeyProperties.DIGEST_NONE);
      if (strongBox && Build.VERSION.SDK_INT >= 28) builder.setIsStrongBoxBacked(true);
      KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519", PROVIDER);
      generator.initialize(builder.build());
      KeyPair pair = generator.generateKeyPair();
      KeyFactory factory = KeyFactory.getInstance("Ed25519", PROVIDER);
      KeyInfo info = (KeyInfo) factory.getKeySpec(pair.getPrivate(), KeyInfo.class);
      Signature signer = Signature.getInstance("Ed25519");
      signer.initSign(pair.getPrivate());
      signer.update(TEST_MESSAGE);
      byte[] signature = signer.sign();
      Signature verifier = Signature.getInstance("Ed25519");
      verifier.initVerify(pair.getPublic());
      verifier.update(TEST_MESSAGE);

      result.put("supported", true);
      result.put("security_level", securityLevel(info));
      result.put("inside_secure_hardware", insideSecureHardware(info));
      result.put("sign_verify", verifier.verify(signature));
      result.put("key_export_attempt", pair.getPrivate().getEncoded() == null ? "non-exportable" : "exportable-unexpected");
    } catch (Throwable failure) {
      putFailure(result, failure);
    } finally {
      delete(alias);
    }
    return result;
  }

  private static JSONObject base(String operation, boolean strongBoxRequested) {
    JSONObject result = new JSONObject();
    put(result, "operation", operation);
    put(result, "strongbox_requested", strongBoxRequested);
    return result;
  }

  private static JSONObject unsupported(String operation, String reason) {
    JSONObject result = base(operation, true);
    put(result, "supported", false);
    put(result, "failure", reason);
    return result;
  }

  private static void putFailure(JSONObject result, Throwable failure) {
    put(result, "supported", false);
    put(result, "failure_class", failure.getClass().getSimpleName());
    put(result, "failure", safeMessage(failure));
  }

  private static JSONObject error(Throwable failure) {
    JSONObject result = new JSONObject();
    put(result, "schema", "ogp-h2-keystore-capability-v1");
    put(result, "fatal", true);
    put(result, "failure_class", failure.getClass().getSimpleName());
    put(result, "failure", safeMessage(failure));
    return result;
  }

  private static String safeLabel(String value) {
    if (value == null || !value.matches("[A-Za-z0-9_-]{1,24}")) return "unlabeled";
    return value;
  }

  private static String safeMessage(Throwable failure) {
    String message = failure.getMessage();
    if (message == null) return "no-message";
    return message.replaceAll("[^A-Za-z0-9 _.,:;()/_-]", "?").substring(0, Math.min(240, message.length()));
  }

  private static void put(JSONObject target, String key, Object value) {
    try {
      target.put(key, value);
    } catch (Exception ignored) {
      // Fixed local keys and primitive values cannot normally fail JSON encoding.
    }
  }

  private static KeyStore keyStore() throws Exception {
    KeyStore store = KeyStore.getInstance(PROVIDER);
    store.load(null);
    return store;
  }

  private static void delete(String alias) {
    try {
      KeyStore store = keyStore();
      if (store.containsAlias(alias)) store.deleteEntry(alias);
    } catch (Exception ignored) {
      // Cleanup failure is visible on a subsequent generate attempt and grants no authority.
    }
  }

  private static String securityLevel(KeyInfo info) {
    if (Build.VERSION.SDK_INT < 31) return info.isInsideSecureHardware() ? "SECURE_HARDWARE_LEGACY" : "SOFTWARE";
    int level = info.getSecurityLevel();
    if (level == KeyProperties.SECURITY_LEVEL_STRONGBOX) return "STRONGBOX";
    if (level == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT) return "TRUSTED_ENVIRONMENT";
    if (level == KeyProperties.SECURITY_LEVEL_SOFTWARE) return "SOFTWARE";
    if (level == KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE) return "UNKNOWN_SECURE";
    return "UNKNOWN";
  }

  @SuppressWarnings("deprecation")
  private static boolean insideSecureHardware(KeyInfo info) {
    return Build.VERSION.SDK_INT >= 31
      ? info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_STRONGBOX
        || info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT
        || info.getSecurityLevel() == KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE
      : info.isInsideSecureHardware();
  }

  private static boolean containsAttestationExtension(Certificate[] chain) {
    if (chain == null) return false;
    for (Certificate certificate : chain) {
      if (certificate instanceof java.security.cert.X509Certificate) {
        java.security.cert.X509Certificate x509 = (java.security.cert.X509Certificate) certificate;
        if (x509.getExtensionValue(ATTESTATION_OID) != null) return true;
      }
    }
    return false;
  }
}

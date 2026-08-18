#!/usr/bin/env bash
set -euo pipefail

apk="${1:?usage: verify-h0-android-artifact.sh <apk>}"
test -f "$apk"

android_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
test -n "$android_sdk"
build_tools="$(find "$android_sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
test -n "$build_tools"

"$build_tools/apksigner" verify --verbose --print-certs "$apk"
"$build_tools/aapt" dump badging "$apk" | grep -E "^(package:|sdkVersion:|targetSdkVersion:|native-code:)"

manifest="$("$build_tools/aapt" dump xmltree "$apk" AndroidManifest.xml)"
grep -q 'A: android:allowBackup.*0x0' <<<"$manifest"
if grep -q 'A: android:debuggable.*0xffffffff' <<<"$manifest"; then
  echo 'H0 APK must not be debuggable' >&2
  exit 1
fi
if grep -Eq 'A: android:(fullBackupContent|dataExtractionRules)' <<<"$manifest"; then
  echo 'H0 payer must not reference Android backup or extraction rules' >&2
  exit 1
fi
for forbidden_permission in \
  android.permission.SYSTEM_ALERT_WINDOW \
  android.permission.READ_EXTERNAL_STORAGE \
  android.permission.WRITE_EXTERNAL_STORAGE; do
  if grep -q "A: android:name.*=\"$forbidden_permission\"" <<<"$manifest"; then
    echo "H0 payer contains forbidden Android permission: $forbidden_permission" >&2
    exit 1
  fi
done

unzip -l "$apk" | grep -E 'assets/(index\.android\.bundle|_expo/static/js/android/.+\.(js|hbc))'
unzip -l "$apk" | grep -q 'lib/arm64-v8a/'
if unzip -l "$apk" | grep -Eq 'lib/(armeabi-v7a|x86|x86_64)/'; then
  echo 'Unexpected non-arm64 native library in H0 APK' >&2
  exit 1
fi

sha256sum "$apk" | tee "${apk}.sha256"

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
grep -q 'A: android:allowBackup.*0xffffffff' <<<"$manifest"
if grep -q 'A: android:debuggable.*0xffffffff' <<<"$manifest"; then
  echo 'H0 APK must not be debuggable' >&2
  exit 1
fi

apkanalyzer="$android_sdk/cmdline-tools/latest/bin/apkanalyzer"
test -x "$apkanalyzer"
backup_file="$("$apkanalyzer" resources value --config default --type xml --name secure_store_backup_rules --package protocol.ogp.payer "$apk")"
extraction_file="$("$apkanalyzer" resources value --config default --type xml --name secure_store_data_extraction_rules --package protocol.ogp.payer "$apk")"
backup_rules="$("$apkanalyzer" resources xml --file "$backup_file" "$apk")"
extraction_rules="$("$apkanalyzer" resources xml --file "$extraction_file" "$apk")"

test "$(grep -c '<include' <<<"$backup_rules")" -eq 1
test "$(grep -c 'domain="sharedpref"' <<<"$backup_rules")" -eq 2
grep -q 'path="SecureStore"' <<<"$backup_rules"
test "$(grep -c '<include' <<<"$extraction_rules")" -eq 2
test "$(grep -c 'domain="sharedpref"' <<<"$extraction_rules")" -eq 4
test "$(grep -c 'path="SecureStore"' <<<"$extraction_rules")" -eq 2
if grep -Eq 'domain="(database|file|root|external|device_database|device_file|device_root)"' <<<"$backup_rules$extraction_rules"; then
  echo 'H0 backup policy unexpectedly includes application data outside shared preferences' >&2
  exit 1
fi

unzip -l "$apk" | grep -E 'assets/(index\.android\.bundle|_expo/static/js/android/.+\.(js|hbc))'
unzip -l "$apk" | grep -q 'lib/arm64-v8a/'
if unzip -l "$apk" | grep -Eq 'lib/(armeabi-v7a|x86|x86_64)/'; then
  echo 'Unexpected non-arm64 native library in H0 APK' >&2
  exit 1
fi

sha256sum "$apk" | tee "${apk}.sha256"

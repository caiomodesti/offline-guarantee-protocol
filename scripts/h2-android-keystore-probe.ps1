param(
  [ValidateSet('Build', 'Verify', 'Install', 'Run', 'Capture', 'All')]
  [string]$Action = 'Build',
  [string]$Serial,
  [ValidatePattern('^[A-Za-z0-9_-]{1,24}$')]
  [string]$DeviceLabel = 'unlabeled',
  [string]$AndroidSdk = "$env:LOCALAPPDATA\Android\Sdk"
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$probeRoot = Join-Path $repositoryRoot 'spikes\android-keystore-probe'
$artifactRoot = Join-Path $repositoryRoot 'artifacts\security-hardening\h2\keystore-probe'
$buildTools = Join-Path $AndroidSdk 'build-tools\36.0.0'
$androidJar = Join-Path $AndroidSdk 'platforms\android-36\android.jar'
$adb = Join-Path $AndroidSdk 'platform-tools\adb.exe'
$javac = 'C:\Program Files\Java\jdk-17\bin\javac.exe'
$jar = 'C:\Program Files\Java\jdk-17\bin\jar.exe'
$keytool = 'C:\Program Files\Java\jdk-17\bin\keytool.exe'
$packageName = 'protocol.ogp.h2probe'
$component = "$packageName/.ProbeActivity"

function Require-File([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name não encontrado em $Path" }
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Name) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Name falhou com exit code $LASTEXITCODE" }
}

function New-Build {
  Require-File $androidJar 'android.jar'
  Require-File $javac 'javac'
  Require-File $jar 'jar'
  Require-File $keytool 'keytool'
  $aapt2 = Join-Path $buildTools 'aapt2.exe'
  $aapt = Join-Path $buildTools 'aapt.exe'
  $d8 = Join-Path $buildTools 'd8.bat'
  $zipalign = Join-Path $buildTools 'zipalign.exe'
  $apksigner = Join-Path $buildTools 'apksigner.bat'
  foreach ($tool in @($aapt2, $aapt, $d8, $zipalign, $apksigner)) { Require-File $tool 'Android build tool' }

  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $runRoot = Join-Path $artifactRoot $stamp
  $classes = Join-Path $runRoot 'classes'
  $dex = Join-Path $runRoot 'dex'
  New-Item -ItemType Directory -Force -Path $classes, $dex | Out-Null
  $unsigned = Join-Path $runRoot 'probe-unsigned.apk'
  $aligned = Join-Path $runRoot 'probe-aligned.apk'
  $signed = Join-Path $runRoot 'ogp-h2-keystore-probe.apk'
  $keystore = Join-Path $runRoot 'ephemeral-probe-signing.p12'
  $classJar = Join-Path $runRoot 'probe-classes.jar'
  $source = Join-Path $probeRoot 'src\protocol\ogp\h2probe\ProbeActivity.java'
  $manifest = Join-Path $probeRoot 'AndroidManifest.xml'

  Invoke-Checked $javac @('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', $androidJar, '-d', $classes, $source) 'javac'
  Invoke-Checked $jar @('cf', $classJar, '-C', $classes, '.') 'class jar creation'
  Invoke-Checked $d8 @('--lib', $androidJar, '--min-api', '23', '--output', $dex, $classJar) 'd8'
  Invoke-Checked $aapt2 @('link', '-o', $unsigned, '-I', $androidJar, '--manifest', $manifest) 'aapt2 link'
  Push-Location $dex
  try { Invoke-Checked $aapt @('add', $unsigned, 'classes.dex') 'aapt add classes.dex' } finally { Pop-Location }
  Invoke-Checked $zipalign @('-f', '4', $unsigned, $aligned) 'zipalign'
  Invoke-Checked $keytool @('-genkeypair', '-noprompt', '-storetype', 'PKCS12', '-keystore', $keystore, '-storepass', 'ogp-h2-probe-only', '-keypass', 'ogp-h2-probe-only', '-alias', 'ogp-h2-probe', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '7', '-dname', 'CN=OGP H2 Capability Probe') 'ephemeral key generation'
  Invoke-Checked $apksigner @('sign', '--ks', $keystore, '--ks-pass', 'pass:ogp-h2-probe-only', '--key-pass', 'pass:ogp-h2-probe-only', '--out', $signed, $aligned) 'APK signing'
  $hash = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$signed.sha256" -Value "$hash  ogp-h2-keystore-probe.apk" -Encoding ascii
  Verify-ProbeApk $signed
  Write-Output "H2_PROBE_APK=$signed"
  Write-Output "H2_PROBE_SHA256=$hash"
  return $signed
}

function Verify-ProbeApk([string]$Apk) {
  Require-File $Apk 'APK H2'
  $aapt = Join-Path $buildTools 'aapt.exe'
  $apksigner = Join-Path $buildTools 'apksigner.bat'
  Require-File $aapt 'aapt'
  Require-File $apksigner 'apksigner'
  Invoke-Checked $apksigner @('verify', '--verbose', $Apk) 'verificação da assinatura do APK H2'

  $badging = (& $aapt dump badging $Apk | Out-String)
  if ($LASTEXITCODE -ne 0 -or $badging -notmatch "package: name='$([regex]::Escape($packageName))'") {
    throw 'APK H2 possui package inesperado'
  }
  $permissions = (& $aapt dump permissions $Apk | Out-String)
  if ($LASTEXITCODE -ne 0 -or $permissions -match 'uses-permission') {
    throw 'APK H2 não pode declarar permissões'
  }
  $manifest = (& $aapt dump xmltree $Apk AndroidManifest.xml | Out-String)
  if ($LASTEXITCODE -ne 0 -or $manifest -notmatch 'android:allowBackup.*0x0' -or $manifest -notmatch 'android:debuggable.*0x0') {
    throw 'APK H2 deve desabilitar backup e debug'
  }

  $sidecar = "$Apk.sha256"
  Require-File $sidecar 'sidecar SHA-256 do APK H2'
  $expected = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0].ToUpperInvariant()
  $actual = (Get-FileHash -LiteralPath $Apk -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($expected -notmatch '^[0-9A-F]{64}$' -or $actual -ne $expected) {
    throw 'SHA-256 do APK H2 diverge do sidecar gerado no build'
  }
}

function Require-PhysicalDevice {
  Require-File $adb 'adb'
  if ([string]::IsNullOrWhiteSpace($Serial)) { throw 'Serial explícito é obrigatório para ações no aparelho' }
  $state = (& $adb -s $Serial get-state 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $state -ne 'device') { throw 'Aparelho explícito não está autorizado como device' }
  $qemu = (& $adb -s $Serial shell getprop ro.kernel.qemu | Out-String).Trim()
  if ($qemu -eq '1') { throw 'H2 exige aparelho físico; emulador rejeitado' }
}

function Latest-Apk {
  $apk = Get-ChildItem -LiteralPath $artifactRoot -Recurse -File -Filter 'ogp-h2-keystore-probe.apk' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($null -eq $apk) { throw 'Nenhum APK H2 compilado; execute -Action Build primeiro' }
  return $apk.FullName
}

function Install-Probe([string]$Apk) {
  Require-PhysicalDevice
  Verify-ProbeApk $Apk
  Invoke-Checked $adb @('-s', $Serial, 'install', '-r', $Apk) 'instalação do probe H2'
}

function Run-Probe {
  Require-PhysicalDevice
  Invoke-Checked $adb @('-s', $Serial, 'logcat', '-c') 'limpeza do logcat H2'
  Invoke-Checked $adb @('-s', $Serial, 'shell', 'am', 'force-stop', $packageName) 'force-stop do probe H2'
  Invoke-Checked $adb @('-s', $Serial, 'shell', 'am', 'start', '-n', $component, '--es', 'device_label', $DeviceLabel) 'execução do probe H2'
}

function Capture-Probe {
  Require-PhysicalDevice
  $deadline = (Get-Date).AddSeconds(45)
  $captured = ''
  do {
    Start-Sleep -Milliseconds 500
    $captured = (& $adb -s $Serial logcat -d -s 'OGP_H2:I' '*:S' | Out-String)
  } while ($captured -notmatch 'OGP_H2_JSON_B64=([A-Za-z0-9+/=]+)' -and (Get-Date) -lt $deadline)
  if ($captured -notmatch 'OGP_H2_JSON_B64=([A-Za-z0-9+/=]+)') { throw 'Resultado H2 não apareceu no logcat dentro de 45 segundos' }
  $encoded = $Matches[1]
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $result = $json | ConvertFrom-Json
  } catch {
    throw 'Resultado H2 não é JSON base64 íntegro'
  }
  if ($result.schema -ne 'ogp-h2-keystore-capability-v1') { throw 'Schema inesperado no resultado H2' }
  if ($result.device_label -ne $DeviceLabel) { throw 'Resultado H2 pertence a outro label de aparelho/execução' }
  if ($result.fatal -eq $true) { throw 'Probe H2 reportou falha fatal; resultado não serve como evidência' }
  if ($result.network_permission -ne $false -or $result.protocol_effect -ne 'none') { throw 'Resultado H2 viola isolamento esperado' }
  if ($result.attestation_verification -ne 'not-performed-on-device') { throw 'Resultado H2 atribui confiança indevida à verificação local' }
  if ($null -eq $result.measurements -or @($result.measurements).Count -ne 6) { throw 'Resultado H2 não contém as seis medições esperadas' }
  foreach ($measurement in @($result.measurements)) {
    if ([string]::IsNullOrWhiteSpace($measurement.operation) -or $null -eq $measurement.strongbox_requested -or $null -eq $measurement.supported) {
      throw 'Medição H2 incompleta'
    }
  }
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $evidenceRoot = Join-Path $artifactRoot "evidence\$DeviceLabel\$stamp"
  New-Item -ItemType Directory -Force -Path $evidenceRoot | Out-Null
  $evidence = Join-Path $evidenceRoot 'keystore-capabilities.json'
  Set-Content -LiteralPath $evidence -Value $json -Encoding utf8
  $hash = (Get-FileHash -LiteralPath $evidence -Algorithm SHA256).Hash
  Set-Content -LiteralPath "$evidence.sha256" -Value "$hash  keystore-capabilities.json" -Encoding ascii
  Write-Output "H2_EVIDENCE=$evidence"
  Write-Output "H2_EVIDENCE_SHA256=$hash"
  Write-Output $json
}

switch ($Action) {
  'Build' { New-Build }
  'Verify' {
    $apk = Latest-Apk
    Verify-ProbeApk $apk
    Write-Output "H2_PROBE_VERIFIED=$apk"
  }
  'Install' { Install-Probe (Latest-Apk) }
  'Run' { Run-Probe }
  'Capture' { Capture-Probe }
  'All' {
    $apk = New-Build | Select-Object -Last 1
    if ($apk -notlike '*.apk') { $apk = Latest-Apk }
    Install-Probe $apk
    Run-Probe
    Capture-Probe
  }
}

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Inventory", "Install", "ClearData", "UninstallReinstall", "Launch", "Capture")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$Serial,

    [string]$ApkPath,
    [string]$EvidenceRoot = "artifacts/security-hardening/h0/devices"
)

$ErrorActionPreference = "Stop"
$PackageName = "protocol.ogp.payer"
$Adb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
$BuildToolsRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk\build-tools"

if (-not (Test-Path -LiteralPath $Adb -PathType Leaf)) {
    throw "ADB nao encontrado em $Adb"
}

$Attached = & $Adb devices -l
$DeviceLine = $Attached | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s+device\b" }
if (-not $DeviceLine) {
    throw "O device '$Serial' nao esta conectado e autorizado. Saida ADB: $($Attached -join ' | ')"
}

$DeviceType = (& $Adb -s $Serial shell getprop ro.build.characteristics).Trim()
if ($DeviceType -match "emulator") {
    throw "H0 exige aparelho fisico; '$Serial' foi identificado como emulator."
}

$SafeSerial = $Serial -replace "[^A-Za-z0-9._-]", "_"
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$EvidenceDir = Join-Path $EvidenceRoot (Join-Path $SafeSerial $Stamp)
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $Adb -s $Serial @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "ADB falhou ($LASTEXITCODE): adb -s $Serial $($Arguments -join ' ')"
    }
}

function Require-Apk {
    if (-not $ApkPath) {
        throw "ApkPath e obrigatorio para a acao $Action."
    }
    $script:ResolvedApk = (Resolve-Path -LiteralPath $ApkPath).Path
    if (-not (Test-Path -LiteralPath $script:ResolvedApk -PathType Leaf)) {
        throw "APK nao encontrado: $ApkPath"
    }

    $BuildTools = Get-ChildItem -LiteralPath $BuildToolsRoot -Directory |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $BuildTools) {
        throw "Android build-tools nao encontrados em $BuildToolsRoot"
    }

    $ApkSigner = Join-Path $BuildTools.FullName "apksigner.bat"
    $Aapt = Join-Path $BuildTools.FullName "aapt.exe"
    & $ApkSigner verify --verbose $script:ResolvedApk | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Assinatura APK invalida: $script:ResolvedApk"
    }

    $Badging = & $Aapt dump badging $script:ResolvedApk
    if ($LASTEXITCODE -ne 0 -or $Badging -notmatch "package: name='$([regex]::Escape($PackageName))'") {
        throw "O APK nao pertence ao package esperado $PackageName"
    }
    if ($Badging -notmatch "native-code: 'arm64-v8a'") {
        throw "O APK H0 deve conter somente a arquitetura arm64-v8a"
    }

    $DeviceAbis = (Invoke-Adb shell getprop ro.product.cpu.abilist).Trim()
    if ($DeviceAbis -notmatch "(^|,)arm64-v8a(,|$)") {
        throw "O aparelho $Serial nao suporta o APK arm64-v8a: $DeviceAbis"
    }

    $Sidecar = "$($script:ResolvedApk).sha256"
    if (-not (Test-Path -LiteralPath $Sidecar -PathType Leaf)) {
        throw "Sidecar SHA-256 obrigatorio nao encontrado: $Sidecar"
    }
    $ExpectedHash = ((Get-Content -LiteralPath $Sidecar -Raw).Trim() -split "\s+")[0].ToUpperInvariant()
    $script:ResolvedApkSha256 = (Get-FileHash -LiteralPath $script:ResolvedApk -Algorithm SHA256).Hash
    if ($script:ResolvedApkSha256 -ne $ExpectedHash) {
        throw "SHA-256 do APK diverge do sidecar CI"
    }
}

function Write-Inventory {
    $Properties = [ordered]@{
        captured_at_utc = (Get-Date).ToUniversalTime().ToString("o")
        serial = $Serial
        manufacturer = (Invoke-Adb shell getprop ro.product.manufacturer).Trim()
        model = (Invoke-Adb shell getprop ro.product.model).Trim()
        android_release = (Invoke-Adb shell getprop ro.build.version.release).Trim()
        sdk = (Invoke-Adb shell getprop ro.build.version.sdk).Trim()
        characteristics = $DeviceType
        package = $PackageName
        package_installed = [bool]((Invoke-Adb shell pm list packages $PackageName) -match "package:$([regex]::Escape($PackageName))")
    }
    $Properties | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDir "inventory.json") -Encoding utf8
    return $Properties
}

function Start-Payer {
    Invoke-Adb shell monkey -p $PackageName -c android.intent.category.LAUNCHER 1 | Out-Null
    Start-Sleep -Seconds 2
}

function Capture-Evidence {
    Invoke-Adb logcat -d -v threadtime | Set-Content -LiteralPath (Join-Path $EvidenceDir "logcat.txt") -Encoding utf8
    $ScreenshotPath = Join-Path $EvidenceDir "screen.png"
    $RemoteScreenshot = "/data/local/tmp/ogp-h0-screen-$SafeSerial.png"
    Invoke-Adb shell screencap -p $RemoteScreenshot
    try {
        Invoke-Adb pull $RemoteScreenshot $ScreenshotPath | Out-Null
    }
    finally {
        Invoke-Adb shell rm -f $RemoteScreenshot | Out-Null
    }
}

$Inventory = Write-Inventory

switch ($Action) {
    "Inventory" {
        $Inventory
    }
    "Install" {
        Require-Apk
        Invoke-Adb install -r $ResolvedApk
        Start-Payer
        Capture-Evidence
    }
    "ClearData" {
        Invoke-Adb shell pm clear $PackageName
        Start-Payer
        Capture-Evidence
    }
    "UninstallReinstall" {
        Require-Apk
        Invoke-Adb uninstall $PackageName
        Invoke-Adb install $ResolvedApk
        Start-Payer
        Capture-Evidence
    }
    "Launch" {
        Start-Payer
        Capture-Evidence
    }
    "Capture" {
        Capture-Evidence
    }
}

[ordered]@{
    action = $Action
    serial = $Serial
    package = $PackageName
    apk_sha256 = $script:ResolvedApkSha256
    evidence_dir = (Resolve-Path -LiteralPath $EvidenceDir).Path
    completed_at_utc = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDir "result.json") -Encoding utf8

Write-Host "H0 $Action concluido para $Serial. Evidencia: $EvidenceDir"

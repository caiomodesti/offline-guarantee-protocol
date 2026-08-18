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
$AndroidUserId = (& $Adb -s $Serial shell am get-current-user).Trim()
if ($LASTEXITCODE -ne 0 -or $AndroidUserId -notmatch "^\d+$") {
    throw "Nao foi possivel determinar o usuario Android ativo no aparelho $Serial."
}

$SafeSerial = $Serial -replace "[^A-Za-z0-9._-]", "_"
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$EvidenceDir = Join-Path $EvidenceRoot (Join-Path $SafeSerial $Stamp)
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Invoke-Adb {
    param([Parameter(Mandatory = $true)][string[]]$AdbArguments)
    & $Adb -s $Serial @AdbArguments
    if ($LASTEXITCODE -ne 0) {
        throw "ADB falhou ($LASTEXITCODE): adb -s $Serial $($AdbArguments -join ' ')"
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
    $BadgingText = $Badging -join "`n"
    if ($LASTEXITCODE -ne 0 -or $BadgingText -notmatch "package: name='$([regex]::Escape($PackageName))'") {
        throw "O APK nao pertence ao package esperado $PackageName"
    }
    if ($BadgingText -notmatch "native-code: 'arm64-v8a'") {
        throw "O APK H0 deve conter somente a arquitetura arm64-v8a"
    }

    $DeviceAbis = (Invoke-Adb -AdbArguments @("shell", "getprop", "ro.product.cpu.abilist")).Trim()
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
        manufacturer = (Invoke-Adb -AdbArguments @("shell", "getprop", "ro.product.manufacturer")).Trim()
        model = (Invoke-Adb -AdbArguments @("shell", "getprop", "ro.product.model")).Trim()
        android_release = (Invoke-Adb -AdbArguments @("shell", "getprop", "ro.build.version.release")).Trim()
        sdk = (Invoke-Adb -AdbArguments @("shell", "getprop", "ro.build.version.sdk")).Trim()
        characteristics = $DeviceType
        android_user_id = $AndroidUserId
        package = $PackageName
        package_installed = [bool]((Invoke-Adb -AdbArguments @("shell", "pm", "list", "packages", "--user", $AndroidUserId, $PackageName)) -match "package:$([regex]::Escape($PackageName))")
    }
    $Properties | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceDir "inventory.json") -Encoding utf8
    return $Properties
}

function Start-Payer {
    Invoke-Adb -AdbArguments @("logcat", "-c") | Out-Null
    $ResolvedActivity = (Invoke-Adb -AdbArguments @("shell", "cmd", "package", "resolve-activity", "--brief", "--user", $AndroidUserId, $PackageName) |
        Select-Object -Last 1).Trim()
    if ($ResolvedActivity -notmatch "^$([regex]::Escape($PackageName))/.+") {
        throw "Nao foi possivel resolver a activity launcher de $PackageName para o usuario Android $AndroidUserId."
    }
    Invoke-Adb -AdbArguments @("shell", "am", "start", "--user", $AndroidUserId, "-W", "-n", $ResolvedActivity) | Out-Null
    Start-Sleep -Seconds 2
}

function Assert-PayerForeground {
    $TopResumed = (Invoke-Adb -AdbArguments @("shell", "dumpsys", "activity", "activities") |
        Where-Object { $_ -match "topResumedActivity=" } |
        Select-Object -First 1)
    if (-not $TopResumed -or $TopResumed -notmatch "\b$([regex]::Escape($PackageName))/.+") {
        throw "O payer nao esta em primeiro plano; captura H0 recusada. Atividade observada: $TopResumed"
    }
}

function Capture-Evidence {
    Assert-PayerForeground
    Invoke-Adb -AdbArguments @("logcat", "-d", "-v", "threadtime") | Set-Content -LiteralPath (Join-Path $EvidenceDir "logcat.txt") -Encoding utf8
    $ScreenshotPath = Join-Path $EvidenceDir "screen.png"
    $RemoteScreenshot = "/data/local/tmp/ogp-h0-screen-$SafeSerial.png"
    Invoke-Adb -AdbArguments @("shell", "screencap", "-p", $RemoteScreenshot)
    try {
        Invoke-Adb -AdbArguments @("pull", $RemoteScreenshot, $ScreenshotPath) | Out-Null
    }
    finally {
        Invoke-Adb -AdbArguments @("shell", "rm", "-f", $RemoteScreenshot) | Out-Null
    }
}

$Inventory = Write-Inventory

switch ($Action) {
    "Inventory" {
        $Inventory
    }
    "Install" {
        Require-Apk
        Invoke-Adb -AdbArguments @("install", "--user", $AndroidUserId, "-r", $ResolvedApk)
        Start-Payer
        Capture-Evidence
    }
    "ClearData" {
        Invoke-Adb -AdbArguments @("shell", "pm", "clear", "--user", $AndroidUserId, $PackageName)
        Start-Payer
        Capture-Evidence
    }
    "UninstallReinstall" {
        Require-Apk
        Invoke-Adb -AdbArguments @("uninstall", "--user", $AndroidUserId, $PackageName)
        Invoke-Adb -AdbArguments @("install", "--user", $AndroidUserId, "-r", $ResolvedApk)
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

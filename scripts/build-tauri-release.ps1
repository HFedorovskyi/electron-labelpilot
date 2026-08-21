[CmdletBinding()]
param(
    [string]$ArtifactDirectory = "artifacts/rust-migration-phase-6-release",
    [string]$ReleaseBaseUrl = "https://github.com/HFedorovskyi/electron-labelpilot/releases/latest/download",
    [string]$SigningKeyPath = "$HOME/.tauri/labelpilot-updater.key",
    [string]$SigningKeyPassword = "",
    [switch]$SkipTests,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repo

if (-not (Test-Path -LiteralPath $SigningKeyPath -PathType Leaf)) {
    throw "Updater signing key not found: $SigningKeyPath"
}
$key = (Resolve-Path -LiteralPath $SigningKeyPath).Path
$publicKey = "$key.pub"
if (-not (Test-Path -LiteralPath $publicKey -PathType Leaf)) {
    throw "Updater public key not found: $publicKey"
}
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue

$artifactPath = Join-Path $repo $ArtifactDirectory
New-Item -ItemType Directory -Force -Path $artifactPath | Out-Null
$verification = [System.Collections.Generic.List[string]]::new()
$verification.Add("LabelPilot Tauri 2.0 release verification")
$verification.Add("timestamp=$([DateTimeOffset]::UtcNow.ToString('o'))")
$verification.Add("BASELINE_COMMAND=npm run build")
$verification.Add("MODIFIED_COMMAND=npm run test:migration; cargo test; tauri build --bundles nsis; tauri signer sign; signature verify")
$verification.Add("INPUT=repository source, updater public key and local private signing key")

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "")
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Invoke-Verified {
    param([string]$Name, [scriptblock]$Command)
    $verification.Add("COMMAND[$Name]=$($Command.ToString().Trim())")
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $captured = @(& $Command 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($null -eq $exitCode) { $exitCode = 0 }
    $verification.Add("OUTPUT_BEGIN[$Name]")
    foreach ($line in $captured) {
        $text = [string]$line
        $verification.Add($text)
        Write-Host $text
    }
    $verification.Add("OUTPUT_END[$Name]")
    $verification.Add("EXIT[$Name]=$exitCode")
    if ($exitCode -ne 0) { throw "$Name failed with exit code $exitCode" }
}

if (-not $SkipTests) {
    Invoke-Verified "migration-contracts" { & npm.cmd run test:migration }
    Invoke-Verified "rust-tests" { & cargo.exe test --manifest-path src-tauri/Cargo.toml }
}

if (-not $SkipBuild) {
    $bundleOverride = 'src-tauri/tauri.local-release.conf.json'
    Invoke-Verified "tauri-nsis" { & npx.cmd tauri build --bundles nsis --config $bundleOverride }
}

$config = Get-Content -LiteralPath "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$expectedPublicKey = ([string]$config.plugins.updater.pubkey).Trim()
$actualPublicKey = (Get-Content -LiteralPath $publicKey -Raw).Trim()
if ($expectedPublicKey -ne $actualPublicKey) {
    throw "Updater public key does not match src-tauri/tauri.conf.json"
}
$version = [string]$config.version
$bundleRoot = Join-Path $repo "src-tauri/target/release/bundle/nsis"
$installer = Get-ChildItem -LiteralPath $bundleRoot -Filter "*.exe" -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $installer) { throw "NSIS installer was not produced in $bundleRoot" }

$signaturePath = "$($installer.FullName).sig"
Remove-Item -LiteralPath $signaturePath -Force -ErrorAction SilentlyContinue
$passwordArgument = "--password=$SigningKeyPassword"
Invoke-Verified "updater-sign" {
    & npx.cmd tauri signer sign -f $key $passwordArgument $installer.FullName
}
if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
    throw "Updater signature was not produced: $signaturePath"
}
Invoke-Verified "updater-verify" {
    & cargo.exe run --quiet --manifest-path src-tauri/Cargo.toml --example verify_update_signature -- $installer.FullName $publicKey $signaturePath
}

$installerOut = Join-Path $artifactPath $installer.Name
$signatureOut = "$installerOut.sig"
Copy-Item -LiteralPath $installer.FullName -Destination $installerOut -Force
Copy-Item -LiteralPath $signaturePath -Destination $signatureOut -Force
$binary = Join-Path $repo "src-tauri/target/release/labelpilot-tauri.exe"
if (Test-Path -LiteralPath $binary -PathType Leaf) {
    Copy-Item -LiteralPath $binary -Destination (Join-Path $artifactPath "LabelPilot.exe") -Force
}

$signature = (Get-Content -LiteralPath $signatureOut -Raw).Trim()
$encodedName = [Uri]::EscapeDataString($installer.Name)
$latest = [ordered]@{
    version = $version
    notes = "LabelPilot $version - Tauri desktop runtime"
    pub_date = [DateTimeOffset]::UtcNow.ToString("o")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url = "$($ReleaseBaseUrl.TrimEnd('/'))/$encodedName"
        }
    }
}
$latestJson = $latest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $artifactPath "latest.json"), $latestJson, [System.Text.UTF8Encoding]::new($false))

$legacyManifest = Join-Path $artifactPath "latest.yml"
Invoke-Verified "legacy-electron-manifest" {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "scripts/new-legacy-electron-manifest.ps1") `
        -InstallerPath $installerOut `
        -Version $version `
        -OutputPath $legacyManifest `
        -ReleaseDate $latest.pub_date
}

$hashRows = Get-ChildItem -LiteralPath $artifactPath -File |
    Where-Object Name -NotIn @("SHA256SUMS.txt", "verification.log") |
    Sort-Object Name |
    ForEach-Object {
        $hash = Get-Sha256 $_.FullName
        "$hash  $($_.Name)"
    }
[System.IO.File]::WriteAllLines((Join-Path $artifactPath "SHA256SUMS.txt"), $hashRows, [System.Text.Encoding]::ASCII)

$verification.Add("VERSION=$version")
$verification.Add("INSTALLER=$installerOut")
$verification.Add("SIGNATURE=$signatureOut")
$verification.Add("LATEST_JSON=$(Join-Path $artifactPath 'latest.json')")
$verification.Add("LATEST_YML=$legacyManifest")
$verification.Add("INSTALLER_SHA256=$(Get-Sha256 $installerOut)")
$verification.Add("RESULT=PASS")
[System.IO.File]::WriteAllLines((Join-Path $artifactPath "verification.log"), $verification, [System.Text.UTF8Encoding]::new($false))

Write-Host "[OK] $installerOut"
Write-Host "[OK] $signatureOut"
Write-Host "[OK] $(Join-Path $artifactPath 'latest.json')"

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SlintExecutable,
    [Parameter(Mandatory = $true)][string]$MaintenanceExecutable,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$ReleaseBaseUrl,
    [string]$SigningKeyPath = '',
    [string]$SigningKeyPassword = '',
    [string]$PublicKeyPath = '',
    [switch]$UseEnvironmentKey
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo
foreach ($path in @($SlintExecutable, $MaintenanceExecutable)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Native update input is missing: $path"
    }
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Invalid semantic version: $Version"
}

$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
New-Item -ItemType Directory -Force -Path $output | Out-Null
$packageName = "LabelPilot_$($Version)_windows_x86_64.lpupdate"
$packagePath = Join-Path $output $packageName
$signaturePath = "$packagePath.sig"
Remove-Item -LiteralPath $packagePath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $signaturePath -Force -ErrorAction SilentlyContinue

& cargo.exe run --quiet --manifest-path src-tauri/Cargo.toml --example build_native_update_package -- $packagePath $SlintExecutable $MaintenanceExecutable $Version
if ($LASTEXITCODE -ne 0) {
    throw "Stored native package build failed with exit code $LASTEXITCODE"
}
if ($UseEnvironmentKey) {
    & npx.cmd tauri signer sign $packagePath
} elseif (-not [string]::IsNullOrWhiteSpace($SigningKeyPath)) {
    $key = (Resolve-Path -LiteralPath $SigningKeyPath).Path
    & npx.cmd tauri signer sign -f $key "--password=$SigningKeyPassword" $packagePath
} else {
    throw 'Specify -SigningKeyPath or -UseEnvironmentKey'
}
if ($LASTEXITCODE -ne 0) {
    throw "Native package signing failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
    throw "Native package signature was not produced: $signaturePath"
}

if (-not [string]::IsNullOrWhiteSpace($PublicKeyPath)) {
    & cargo.exe run --quiet --manifest-path src-tauri/Cargo.toml --example verify_update_signature -- $packagePath $PublicKeyPath $signaturePath
    if ($LASTEXITCODE -ne 0) {
        throw "Native package signature verification failed with exit code $LASTEXITCODE"
    }
}

$packageInfo = Get-Item -LiteralPath $packagePath
$sha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
$signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
$publishedAt = [DateTimeOffset]::UtcNow.ToString('o')
$assetUrl = "$($ReleaseBaseUrl.TrimEnd('/'))/$([Uri]::EscapeDataString($packageName))"
$manifest = [ordered]@{
    schema = 1
    version = $Version
    notes = "LabelPilot $Version - native Slint runtime, transactional updater and automatic rollback"
    publishedAt = $publishedAt
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            url = $assetUrl
            signature = $signature
            sha256 = $sha256
            size = [uint64]$packageInfo.Length
            format = 'portable-zip'
        }
    }
}
$manifestPath = Join-Path $output 'native-latest.json'
[IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 8),
    [Text.UTF8Encoding]::new($false)
)
Write-Host "NATIVE_UPDATE_OK version=$Version bytes=$($packageInfo.Length) sha256=$sha256"
Write-Host "[OK] package=$packagePath"
Write-Host "[OK] signature=$signaturePath"
Write-Host "[OK] manifest=$manifestPath"

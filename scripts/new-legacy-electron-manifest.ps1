[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$OutputPath = "latest.yml",
    [string]$ReleaseDate = [DateTimeOffset]::UtcNow.ToString("o")
)

$ErrorActionPreference = "Stop"

function Get-Sha512Base64 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha512 = [System.Security.Cryptography.SHA512]::Create()
        try { return [Convert]::ToBase64String($sha512.ComputeHash($stream)) }
        finally { $sha512.Dispose() }
    } finally { $stream.Dispose() }
}

if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Invalid release version: $Version"
}
$installer = Get-Item -LiteralPath $InstallerPath -ErrorAction Stop
if ($installer.PSIsContainer -or $installer.Extension -ine ".exe") {
    throw "Legacy Electron updater requires an EXE installer: $InstallerPath"
}
$parsedDate = [DateTimeOffset]::MinValue
if (-not [DateTimeOffset]::TryParse($ReleaseDate, [ref]$parsedDate)) {
    throw "Invalid release date: $ReleaseDate"
}

$assetName = $installer.Name.Replace("'", "''")
$sha512 = Get-Sha512Base64 -Path $installer.FullName
$releaseDateUtc = $parsedDate.ToUniversalTime().ToString("o")
$yaml = @(
    "version: $Version"
    "files:"
    "  - url: '$assetName'"
    "    sha512: $sha512"
    "    size: $($installer.Length)"
    "path: '$assetName'"
    "sha512: $sha512"
    "releaseDate: '$releaseDateUtc'"
) -join "`n"

$target = [System.IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $target
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
[System.IO.File]::WriteAllText($target, "$yaml`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "LEGACY_MANIFEST_OK version=$Version asset=$($installer.Name) size=$($installer.Length) output=$target"

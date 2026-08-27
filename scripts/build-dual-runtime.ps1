[CmdletBinding()]
param(
    [ValidateSet('nsis', 'msi')][string]$Bundle = 'nsis',
    [switch]$NoBundle,
    [string]$Config = ''
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo

function Invoke-Checked {
    param([string]$Name, [scriptblock]$Command)
    Write-Host "[runtime-build] $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

$hostLine = & rustc.exe -vV | Where-Object { $_ -like 'host:*' } | Select-Object -First 1
if (-not $hostLine) { throw 'rustc did not report a host target triple' }
$targetTriple = ($hostLine -split ':', 2)[1].Trim()
$extension = if ($targetTriple -like '*windows*') { '.exe' } else { '' }

Invoke-Checked 'build Slint sidecar' {
    & cargo.exe build --release --manifest-path src-tauri/Cargo.toml `
        --no-default-features --features slint-ui --bin labelpilot-slint
}


Invoke-Checked 'build maintenance helper' {
    & cargo.exe build --release --manifest-path src-tauri/Cargo.toml --no-default-features --features native-update --bin labelpilot-maintenance
}
$sidecar = Join-Path $repo "src-tauri/target/release/labelpilot-slint$extension"
$maintenance = Join-Path $repo "src-tauri/target/release/labelpilot-maintenance$extension"
if (-not (Test-Path -LiteralPath $maintenance -PathType Leaf)) {
    throw "Maintenance helper was not produced: $maintenance"
}
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
    throw "Slint sidecar was not produced: $sidecar"
}
$binariesDirectory = Join-Path $repo 'src-tauri/binaries'
New-Item -ItemType Directory -Force -Path $binariesDirectory | Out-Null
$bundledSidecar = Join-Path $binariesDirectory "labelpilot-slint-$targetTriple$extension"
Copy-Item -LiteralPath $sidecar -Destination $bundledSidecar -Force
$bundledMaintenance = Join-Path $binariesDirectory "labelpilot-maintenance-$targetTriple$extension"
Copy-Item -LiteralPath $maintenance -Destination $bundledMaintenance -Force

$tauriArguments = @('tauri', 'build')
if ($NoBundle) {
    $tauriArguments += '--no-bundle'
} else {
    $tauriArguments += @('--bundles', $Bundle)
}
if ([string]::IsNullOrWhiteSpace($Config)) {
    $Config = 'src-tauri/tauri.dual-runtime.conf.json'
}
$tauriArguments += @('--config', $Config)
Invoke-Checked 'build Tauri main runtime' {
    & npx.cmd @tauriArguments
}

# `tauri build` also resolves the package's binary targets and can overwrite the
# minimal helper in target/release with a desktop-featured build. Rebuild it
# after bundling so release packaging always picks the low-resource helper.
Invoke-Checked 'restore minimal maintenance helper' {
    & cargo.exe build --release --manifest-path src-tauri/Cargo.toml --no-default-features --features native-update --bin labelpilot-maintenance
}

$mainExecutable = Join-Path $repo "src-tauri/target/release/labelpilot-tauri$extension"
foreach ($path in @($mainExecutable, $sidecar, $maintenance)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Runtime artifact is missing: $path"
    }
}

Write-Host "[OK] main=$mainExecutable"
Write-Host "[OK] slint=$sidecar"
Write-Host "[OK] maintenance=$maintenance"
Write-Host "[OK] bundle-sidecar=$bundledSidecar"
Write-Host "[OK] bundle-maintenance=$bundledMaintenance"

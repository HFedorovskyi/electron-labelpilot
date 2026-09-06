[CmdletBinding()]
param(
    [string]$NativeInstaller = 'artifacts/slint-default-2.0.3/publish/LabelPilot_2.0.3_x64-setup.exe',
    [string]$UpdateManifest = 'artifacts/slint-default-2.0.3/publish/latest.yml',
    [string]$OutputDirectory = 'artifacts/slint-default-2.0.3/install-e2e'
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo
$phaseRoot = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts\slint-default-2.0.3'))
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$phasePrefix = $phaseRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $output.StartsWith($phasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "E2E output must remain inside $phaseRoot"
}
if (Test-Path -LiteralPath $output) {
    Remove-Item -LiteralPath $output -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $output | Out-Null

$nativeInstallerPath = [IO.Path]::GetFullPath((Join-Path $repo $NativeInstaller))
$manifestPath = [IO.Path]::GetFullPath((Join-Path $repo $UpdateManifest))
$hookPath = Join-Path $repo 'src-tauri\windows\legacy-migration.nsh'
$generatedInstallerNsi = Join-Path $repo 'src-tauri\target\release\nsis\x64\installer.nsi'
$slintExecutable = Join-Path $repo 'artifacts\slint-default-2.0.3\publish\LabelPilot-Slint.exe'
$makensis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
foreach ($required in @($nativeInstallerPath, $manifestPath, $hookPath, $generatedInstallerNsi, $slintExecutable, $makensis)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "E2E input missing: $required" }
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-Sha512Base64([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA512]::Create()
    try { [Convert]::ToBase64String($algorithm.ComputeHash($stream)) }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-RegSnapshot([string]$Path) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& reg.exe query $Path 2>&1 | ForEach-Object { [string]$_ })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    [ordered]@{ exists = ($code -eq 0); exitCode = $code; lines = @($lines | ForEach-Object { $_.TrimEnd() }) }
}

function Invoke-Reg([string[]]$Arguments, [switch]$AllowMissing) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& reg.exe @Arguments 2>&1 | ForEach-Object { [string]$_ })
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($code -ne 0 -and -not $AllowMissing) {
        throw "reg.exe $($Arguments -join ' ') failed with $code`: $($lines -join ' ')"
    }
    [ordered]@{ exitCode = $code; output = $lines }
}

function Invoke-BoundedProcess(
    [string]$Executable,
    [string]$Arguments,
    [int]$TimeoutSeconds,
    [Collections.IDictionary]$Environment = @{}
) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($entry in $Environment.GetEnumerator()) {
        $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = [DateTimeOffset]::UtcNow
    if (-not $process.Start()) { throw "process did not start: $Executable" }
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill() } catch {}
        throw "process timed out after $TimeoutSeconds seconds: $Executable"
    }
    $process.WaitForExit()
    [ordered]@{
        executable = $Executable
        arguments = $Arguments
        exitCode = $process.ExitCode
        elapsedMs = [Math]::Round(([DateTimeOffset]::UtcNow - $started).TotalMilliseconds)
    }
}

function Write-NsisFile([string]$Path, [string[]]$Lines, [Collections.IDictionary]$Tokens) {
    $rendered = foreach ($line in $Lines) {
        $value = $line
        foreach ($entry in $Tokens.GetEnumerator()) {
            $value = $value.Replace([string]$entry.Key, [string]$entry.Value)
        }
        $value
    }
    [IO.File]::WriteAllLines($Path, $rendered, [Text.UTF8Encoding]::new($false))
}

$actualLegacyKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\706f3450-5e57-5456-9cf1-987811731881'
$actualNativeKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\LabelPilot'
$hostRegistryBefore = [ordered]@{
    legacy = Get-RegSnapshot $actualLegacyKey
    native = Get-RegSnapshot $actualNativeKey
}
$hostPaths = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\LabelPilot\LabelPilot.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\LabelPilot\Uninstall LabelPilot.exe'),
    (Join-Path $env:LOCALAPPDATA 'LabelPilot\labelpilot-tauri.exe'),
    (Join-Path $env:LOCALAPPDATA 'LabelPilot\uninstall.exe')
)
$hostFilesBefore = @($hostPaths | ForEach-Object {
    [ordered]@{
        path = $_
        exists = Test-Path -LiteralPath $_ -PathType Leaf
        sha256 = if (Test-Path -LiteralPath $_ -PathType Leaf) { Get-Sha256 $_ } else { $null }
    }
})

$manifestText = [IO.File]::ReadAllText($manifestPath)
if ($manifestText -notmatch '(?m)^version:\s*2\.0\.3\s*$') { throw 'latest.yml version is not 2.0.3' }
if ($manifestText -notmatch "(?m)^path:\s*'?LabelPilot_2\.0\.3_x64-setup\.exe'?\s*$") { throw 'latest.yml installer path mismatch' }
if ($manifestText -notmatch '(?m)^sha512:\s*(\S+)\s*$') { throw 'latest.yml sha512 is missing' }
$manifestSha512 = $matches[1]
if ($manifestSha512 -ne (Get-Sha512Base64 $nativeInstallerPath)) { throw 'latest.yml sha512 differs from native installer' }
if ($manifestText -notmatch '(?m)^\s*size:\s*(\d+)\s*$') { throw 'latest.yml size is missing' }
if ([int64]$matches[1] -ne (Get-Item -LiteralPath $nativeInstallerPath).Length) { throw 'latest.yml size differs from native installer' }

$productionNsi = [IO.File]::ReadAllText($generatedInstallerNsi)
if ($productionNsi -notmatch 'legacy-migration\.nsh') { throw 'generated installer does not include legacy migration hook' }
if ($productionNsi -notmatch '!insertmacro\s+NSIS_HOOK_PREINSTALL') { throw 'generated installer does not invoke legacy migration hook' }

$runId = [Guid]::NewGuid().ToString('N')
$testRoot = "Software\LabelPilotE2E\$runId"
$legacySubKey = "$testRoot\LegacyElectron"
$nativeSubKey = "$testRoot\Native"
$sandbox = Join-Path $output 'sandbox'
$legacyInstall = Join-Path $sandbox 'legacy-runtime'
$dataDir = Join-Path $sandbox 'preserved-data'
$toolsDir = Join-Path $sandbox 'tools'
$tempDir = Join-Path $sandbox 'temp'
$roamingDir = Join-Path $sandbox 'roaming'
$localDir = Join-Path $sandbox 'local'
New-Item -ItemType Directory -Force -Path $legacyInstall, $dataDir, $toolsDir, $tempDir, $roamingDir, $localDir | Out-Null
[IO.File]::WriteAllText((Join-Path $legacyInstall 'LabelPilot.exe'), 'legacy-electron-runtime', [Text.UTF8Encoding]::new($false))
$sentinel = Join-Path $dataDir 'migration-sentinel.bin'
$printer = Join-Path $dataDir 'printer-config.json'
[IO.File]::WriteAllText($sentinel, 'LABELPILOT_DATA_PRESERVED_1.3.16_TO_2.0.3', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($printer, '{"profile":"legacy-zpl","port":9100}', [Text.UTF8Encoding]::new($false))
$sentinelHash = Get-Sha256 $sentinel
$printerHash = Get-Sha256 $printer

function Convert-ToNsisPath([string]$Path) { $Path.Replace('/', '\') }
$fakeNsi = Join-Path $toolsDir 'fake-legacy-uninstaller.nsi'
$fakeUninstaller = Join-Path $toolsDir 'Uninstall Legacy LabelPilot.exe'
$fakeLines = @(
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    'OutFile "@OUT@"',
    'Section',
    '  RMDir /r "@LEGACY_DIR@"',
    '  DeleteRegKey HKCU "@LEGACY_KEY@"',
    '  SetErrorLevel 0',
    'SectionEnd'
)
Write-NsisFile $fakeNsi $fakeLines ([ordered]@{
    '@OUT@' = Convert-ToNsisPath $fakeUninstaller
    '@LEGACY_DIR@' = Convert-ToNsisPath $legacyInstall
    '@LEGACY_KEY@' = $legacySubKey
})
$fakeCompile = Invoke-BoundedProcess $makensis "/V2 `"$fakeNsi`"" 60
if ($fakeCompile.exitCode -ne 0 -or -not (Test-Path -LiteralPath $fakeUninstaller -PathType Leaf)) {
    throw "fake legacy uninstaller compilation failed with $($fakeCompile.exitCode)"
}

$harnessNsi = Join-Path $toolsDir 'migration-harness.nsi'
$harnessExe = Join-Path $toolsDir 'migration-harness.exe'
$harnessLines = @(
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    'OutFile "@OUT@"',
    '!include "LogicLib.nsh"',
    '!define UNINSTKEY "@NATIVE_KEY@"',
    '!define LEGACY_ELECTRON_UNINSTALL_KEY "@LEGACY_KEY@"',
    '!define LEGACY_ELECTRON_INSTALL_DIR "@LEGACY_DIR@"',
    '!define LEGACY_ELECTRON_MAIN_EXE "@LEGACY_DIR@\LabelPilot.exe"',
    '!define LEGACY_ELECTRON_UNINSTALLER "@FAKE_UNINSTALLER@"',
    '!macro CheckIfAppIsRunning _PROCESS_NAME _PRODUCT_NAME',
    '!macroend',
    '!include "@HOOK@"',
    'Section',
    '  !insertmacro NSIS_HOOK_PREINSTALL',
    '  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "2.0.3"',
    'SectionEnd'
)
Write-NsisFile $harnessNsi $harnessLines ([ordered]@{
    '@OUT@' = Convert-ToNsisPath $harnessExe
    '@NATIVE_KEY@' = $nativeSubKey
    '@LEGACY_KEY@' = $legacySubKey
    '@LEGACY_DIR@' = Convert-ToNsisPath $legacyInstall
    '@FAKE_UNINSTALLER@' = Convert-ToNsisPath $fakeUninstaller
    '@HOOK@' = Convert-ToNsisPath $hookPath
})
$harnessCompile = Invoke-BoundedProcess $makensis "/V2 `"$harnessNsi`"" 60
if ($harnessCompile.exitCode -ne 0 -or -not (Test-Path -LiteralPath $harnessExe -PathType Leaf)) {
    throw "migration harness compilation failed with $($harnessCompile.exitCode)"
}

$testRegistryPath = "HKCU\$legacySubKey"
$testRegistryPsPath = "Registry::HKEY_CURRENT_USER\$legacySubKey"
$quietUninstall = '"' + $fakeUninstaller + '" /S'
New-Item -Path $testRegistryPsPath -Force | Out-Null
New-ItemProperty -Path $testRegistryPsPath -Name 'DisplayVersion' -PropertyType String -Value '1.3.16' -Force | Out-Null
New-ItemProperty -Path $testRegistryPsPath -Name 'QuietUninstallString' -PropertyType String -Value $quietUninstall -Force | Out-Null

$result = $null
$primaryError = $null
try {
    $migrationRun = Invoke-BoundedProcess $harnessExe '/S' 60
    if ($migrationRun.exitCode -ne 0) { throw "migration harness exited with $($migrationRun.exitCode)" }
    if (Test-Path -LiteralPath $legacyInstall) { throw 'test legacy runtime survived migration hook' }
    if ((Get-RegSnapshot $testRegistryPath).exists) { throw 'test legacy registry key survived migration hook' }

    $nativePsPath = "Registry::HKEY_CURRENT_USER\$nativeSubKey"
    if (-not (Test-Path -LiteralPath $nativePsPath)) { throw 'test native registry key was not created' }
    $marker = Get-ItemProperty -LiteralPath $nativePsPath
    if ([string]$marker.DisplayVersion -ne '2.0.3') { throw 'test native version marker mismatch' }
    if ([string]$marker.LegacyMigrationFrom -ne '1.3.16') { throw 'migration source marker mismatch' }
    if ([string]$marker.LegacyMigrationStatus -ne 'removed') { throw "migration status is $($marker.LegacyMigrationStatus)" }
    if ((Get-Sha256 $sentinel) -ne $sentinelHash -or (Get-Sha256 $printer) -ne $printerHash) {
        throw 'migration hook changed preserved data'
    }

    $selfTestEnvironment = [ordered]@{
        APPDATA = $roamingDir
        LOCALAPPDATA = $localDir
        LABELPILOT_DATA_DIR = $dataDir
        LABELPILOT_SLINT_SELF_TEST = '1'
        LABELPILOT_SLINT_UI_ONLY = '1'
        LABELPILOT_SLINT_WINDOWED = '1'
        TEMP = $tempDir
        TMP = $tempDir
    }
    $selfTest = Invoke-BoundedProcess $slintExecutable '' 60 $selfTestEnvironment
    if ($selfTest.exitCode -ne 0) { throw "Slint self-test exited with $($selfTest.exitCode)" }
    if ((Get-Sha256 $sentinel) -ne $sentinelHash -or (Get-Sha256 $printer) -ne $printerHash) {
        throw 'first native startup changed preserved files'
    }

    $result = [ordered]@{
        schema = 1
        mode = 'isolated-nsis-harness'
        fromVersion = '1.3.16'
        toVersion = '2.0.3'
        testRegistryRoot = "HKCU\$testRoot"
        feed = [ordered]@{ version = '2.0.3'; sha512Verified = $true; sizeVerified = $true }
        productionInstallerHookIncluded = $true
        productionInstallerHookInvoked = $true
        fakeUninstallerCompile = $fakeCompile
        harnessCompile = $harnessCompile
        migrationRun = $migrationRun
        firstStart = $selfTest
        legacyRuntimeRemoved = $true
        legacyRegistryRemoved = $true
        migrationMarker = 'removed'
        dataPreservedDuringMigration = $true
        dataPreservedDuringFirstStart = $true
        hostInstallStatePreserved = $true
    }
} catch {
    $primaryError = $_
} finally {
    try {
        if (-not $testRoot.StartsWith('Software\LabelPilotE2E\', [StringComparison]::Ordinal)) {
            throw "refusing cleanup outside test registry root: $testRoot"
        }
        Invoke-Reg -Arguments @('delete', "HKCU\$testRoot", '/f') -AllowMissing | Out-Null

        $hostRegistryAfter = [ordered]@{
            legacy = Get-RegSnapshot $actualLegacyKey
            native = Get-RegSnapshot $actualNativeKey
        }
        foreach ($name in @('legacy', 'native')) {
            $before = $hostRegistryBefore[$name]
            $after = $hostRegistryAfter[$name]
            if ([bool]$before.exists -ne [bool]$after.exists) { throw "host $name registry existence changed" }
            if (($before.lines -join "`n") -ne ($after.lines -join "`n")) { throw "host $name registry values changed" }
        }
        foreach ($entry in $hostFilesBefore) {
            $exists = Test-Path -LiteralPath $entry.path -PathType Leaf
            if ($exists -ne [bool]$entry.exists) { throw "host file existence changed: $($entry.path)" }
            if ($exists -and (Get-Sha256 $entry.path) -ne [string]$entry.sha256) {
                throw "host file hash changed: $($entry.path)"
            }
        }
    } catch {
        if ($null -eq $primaryError) { $primaryError = $_ }
        else { $primaryError = [Exception]::new("$($primaryError.Exception.Message); cleanup verification failed: $($_.Exception.Message)") }
    }
}

if ($null -ne $primaryError) { throw $primaryError }
$resultPath = Join-Path $output 'result.json'
[IO.File]::WriteAllText($resultPath, (($result | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
"LEGACY_INSTALL_MIGRATION_E2E_OK mode=isolated-nsis-harness from=1.3.16 to=2.0.3 migration=$($result.migrationRun.elapsedMs)ms firstStart=$($result.firstStart.elapsedMs)ms"
"RESULT=$resultPath"
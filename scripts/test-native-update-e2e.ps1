[CmdletBinding()]
param(
    [string]$OldReleaseDirectory = 'artifacts/native-update-e2e-2.0.1/publish',
    [string]$NewReleaseDirectory = 'artifacts/legacy-install-migration-2.0.2/publish',
    [string]$RollbackProbeDirectory = 'artifacts/legacy-install-migration-2.0.2/rollback-probe',
    [string]$OutputDirectory = 'artifacts/legacy-install-migration-2.0.2/native-update-e2e',
    [string]$FromVersion = '2.0.1',
    [string]$ToVersion = '2.0.2'
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo
$oldRelease = [IO.Path]::GetFullPath((Join-Path $repo $OldReleaseDirectory))
$newRelease = [IO.Path]::GetFullPath((Join-Path $repo $NewReleaseDirectory))
$rollbackProbe = [IO.Path]::GetFullPath((Join-Path $repo $RollbackProbeDirectory))
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$packageName = "LabelPilot_${ToVersion}_windows_x86_64.lpupdate"
$databaseSentinel = "DATABASE_$FromVersion"
$printerSentinel = "{`"profile`":`"zpl-$FromVersion`"}"
$phaseRoot = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts\legacy-install-migration-2.0.2'))
if (-not $output.StartsWith($phaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "E2E output must remain inside $phaseRoot"
}

function Reset-SafeDirectory([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($phaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe E2E directory: $resolved"
    }
    if (Test-Path -LiteralPath $resolved) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    New-Item -ItemType Directory -Path $resolved -Force | Out-Null
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Resolve-RuntimeArtifact([string]$Directory, [string[]]$Names) {
    foreach ($name in $Names) {
        $candidate = Join-Path $Directory $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    throw "Runtime artifact missing from $Directory; expected one of: $($Names -join ', ')"
}

function Stop-TestClient([string]$Executable) {
    $expected = [IO.Path]::GetFullPath($Executable)
    Get-Process -Name 'labelpilot-slint' -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ([IO.Path]::GetFullPath($_.Path) -eq $expected) {
                Stop-Process -Id $_.Id -Force
            }
        } catch {
            # The process may exit between enumeration and Path access.
        }
    }
}

function Prepare-Scenario([string]$Name) {
    $root = Join-Path $output $Name
    Reset-SafeDirectory $root
    $install = Join-Path $root 'install'
    $data = Join-Path $root 'data'
    $transaction = Join-Path $data "updates\transactions\$Name"
    $backup = Join-Path $transaction 'data-backup'
    foreach ($directory in @($install, (Join-Path $data 'outbox'), $transaction, (Join-Path $backup 'outbox'))) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Copy-Item -LiteralPath $oldSlintSource -Destination (Join-Path $install 'labelpilot-slint.exe') -Force
    Copy-Item -LiteralPath $oldMaintenanceSource -Destination (Join-Path $install 'labelpilot-maintenance.exe') -Force
    [IO.File]::WriteAllText((Join-Path $data 'client_data.db'), $databaseSentinel, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $data 'printer-config.json'), $printerSentinel, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $data 'outbox\job-001.lpr'), 'QUEUED_BEFORE_UPDATE', [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $data 'client_data.db') -Destination (Join-Path $backup 'client_data.db') -Force
    Copy-Item -LiteralPath (Join-Path $data 'printer-config.json') -Destination (Join-Path $backup 'printer-config.json') -Force
    Copy-Item -LiteralPath (Join-Path $data 'outbox\job-001.lpr') -Destination (Join-Path $backup 'outbox\job-001.lpr') -Force
    $runner = Join-Path $transaction 'labelpilot-maintenance-runner.exe'
    Copy-Item -LiteralPath (Join-Path $install 'labelpilot-maintenance.exe') -Destination $runner -Force
    [ordered]@{
        root = $root
        install = $install
        data = $data
        transaction = $transaction
        backup = $backup
        runner = $runner
    }
}

function New-ApplyPlan(
    [Collections.IDictionary]$Scenario,
    [string]$ManifestPath,
    [string]$PackagePath,
    [string]$Name
) {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.version -ne $ToVersion) {
        throw "$Name manifest version $($manifest.version) differs from $ToVersion"
    }
    $artifact = $manifest.platforms.'windows-x86_64'
    $actualHash = Get-Sha256 $PackagePath
    $actualSize = (Get-Item -LiteralPath $PackagePath).Length
    if ($actualHash -ne $artifact.sha256 -or $actualSize -ne $artifact.size) {
        throw "$Name package differs from its manifest"
    }
    $token = [Guid]::NewGuid().ToString('N')
    $plan = [ordered]@{
        schema = 1
        packageVersion = [string]$manifest.version
        packageSignature = [string]$artifact.signature
        packageSha256 = [string]$artifact.sha256
        packageSize = [Int64]$artifact.size
        archivePath = [IO.Path]::GetFullPath($PackagePath)
        installRoot = [IO.Path]::GetFullPath($Scenario.install)
        launchExecutable = 'labelpilot-slint.exe'
        healthMarker = Join-Path $Scenario.transaction 'health.ok'
        healthToken = $token
        statusPath = Join-Path $Scenario.transaction 'status.json'
        transactionRoot = [IO.Path]::GetFullPath($Scenario.transaction)
        dataRoot = [IO.Path]::GetFullPath($Scenario.data)
        dataBackup = [IO.Path]::GetFullPath($Scenario.backup)
        parentPid = 0
        startupTimeoutSeconds = 5
    }
    $planPath = Join-Path $Scenario.transaction 'apply-plan.json'
    [IO.File]::WriteAllText($planPath, (($plan | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    [ordered]@{ path = $planPath; value = $plan }
}

function Invoke-Helper([Collections.IDictionary]$Scenario, [string]$PlanPath) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Scenario.runner
    $startInfo.Arguments = "apply --plan `"$PlanPath`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables['LABELPILOT_SLINT_SELF_TEST'] = '1'
    $startInfo.EnvironmentVariables['LABELPILOT_SLINT_UI_ONLY'] = '1'
    $startInfo.EnvironmentVariables['LABELPILOT_SLINT_WINDOWED'] = '1'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $started = [DateTimeOffset]::UtcNow
    if (-not $process.Start()) { throw 'maintenance helper did not start' }
    if (-not $process.WaitForExit(90000)) {
        $process.Kill()
        throw 'maintenance helper timed out after 90 seconds'
    }
    $process.WaitForExit()
    $elapsed = [Math]::Round(([DateTimeOffset]::UtcNow - $started).TotalMilliseconds)
    if ($process.ExitCode -ne 0) {
        throw "maintenance helper exited with $($process.ExitCode)"
    }
    [ordered]@{ exitCode = $process.ExitCode; elapsedMs = $elapsed }
}

function Read-Status([Collections.IDictionary]$Plan) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
    while (-not (Test-Path -LiteralPath $Plan.statusPath) -and [DateTimeOffset]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $Plan.statusPath)) { throw 'maintenance status was not produced' }
    Get-Content -LiteralPath $Plan.statusPath -Raw | ConvertFrom-Json
}

Reset-SafeDirectory $output
$oldSlintSource = Resolve-RuntimeArtifact $oldRelease @('labelpilot-slint.exe', 'LabelPilot-Slint.exe')
$oldMaintenanceSource = Resolve-RuntimeArtifact $oldRelease @('labelpilot-maintenance.exe', 'LabelPilot-Maintenance.exe')
$newSlintSource = Resolve-RuntimeArtifact $newRelease @('labelpilot-slint.exe', 'LabelPilot-Slint.exe')
$newMaintenanceSource = Resolve-RuntimeArtifact $newRelease @('labelpilot-maintenance.exe', 'LabelPilot-Maintenance.exe')
foreach ($required in @(
    $oldSlintSource,
    $oldMaintenanceSource,
    $newSlintSource,
    $newMaintenanceSource,
    (Join-Path $newRelease $packageName),
    (Join-Path $rollbackProbe $packageName)
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "E2E input missing: $required" }
}

$oldSlintHash = Get-Sha256 $oldSlintSource
$oldHelperHash = Get-Sha256 $oldMaintenanceSource
$newSlintHash = Get-Sha256 $newSlintSource
$newHelperHash = Get-Sha256 $newMaintenanceSource
if ($oldSlintHash -eq $newSlintHash -or $oldHelperHash -eq $newHelperHash) {
    throw "$FromVersion and $ToVersion binaries must differ for E2E"
}

$success = Prepare-Scenario 'success'
$successPackage = Join-Path $newRelease $packageName
$successPlan = New-ApplyPlan $success (Join-Path $newRelease 'native-latest.json') $successPackage 'success'
$successRun = Invoke-Helper $success $successPlan.path
$successStatus = Read-Status $successPlan.value
Stop-TestClient (Join-Path $success.install 'labelpilot-slint.exe')
if ($successStatus.state -ne 'confirmed') { throw "expected confirmed, got $($successStatus.state)" }
if ((Get-Sha256 (Join-Path $success.install 'labelpilot-slint.exe')) -ne $newSlintHash) { throw 'success scenario did not install new Slint binary' }
if ((Get-Sha256 (Join-Path $success.install 'labelpilot-maintenance.exe')) -ne $newHelperHash) { throw 'success scenario did not install new helper binary' }
if (([IO.File]::ReadAllText((Join-Path $success.data 'client_data.db'))) -ne $databaseSentinel) { throw 'success scenario changed database' }
if (([IO.File]::ReadAllText((Join-Path $success.data 'outbox\job-001.lpr'))) -ne 'QUEUED_BEFORE_UPDATE') { throw 'success scenario changed print queue' }
if (([IO.File]::ReadAllText($successPlan.value.healthMarker)).Trim() -ne $successPlan.value.healthToken) { throw 'success health token mismatch' }

$rollback = Prepare-Scenario 'rollback'
[IO.File]::WriteAllText((Join-Path $rollback.data 'client_data.db'), 'DATABASE_MUTATED_DURING_UPDATE', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $rollback.data 'printer-config.json'), '{"profile":"mutated"}', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $rollback.data 'outbox\job-001.lpr'), 'QUEUE_CORRUPTED_DURING_UPDATE', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $rollback.data 'outbox\job-002.lpr'), 'QUEUED_AFTER_SNAPSHOT', [Text.UTF8Encoding]::new($false))
$rollbackPackage = Join-Path $rollbackProbe $packageName
$rollbackPlan = New-ApplyPlan $rollback (Join-Path $rollbackProbe 'native-latest.json') $rollbackPackage 'rollback'
$rollbackRun = Invoke-Helper $rollback $rollbackPlan.path
$rollbackStatus = Read-Status $rollbackPlan.value
Stop-TestClient (Join-Path $rollback.install 'labelpilot-slint.exe')
if ($rollbackStatus.state -ne 'rolled-back') { throw "expected rolled-back, got $($rollbackStatus.state)" }
if ((Get-Sha256 (Join-Path $rollback.install 'labelpilot-slint.exe')) -ne $oldSlintHash) { throw 'rollback did not restore old Slint binary' }
if ((Get-Sha256 (Join-Path $rollback.install 'labelpilot-maintenance.exe')) -ne $oldHelperHash) { throw 'rollback did not restore old helper binary' }
if (([IO.File]::ReadAllText((Join-Path $rollback.data 'client_data.db'))) -ne $databaseSentinel) { throw 'rollback did not restore database' }
if (([IO.File]::ReadAllText((Join-Path $rollback.data 'printer-config.json'))) -ne $printerSentinel) { throw 'rollback did not restore printer settings' }
if (([IO.File]::ReadAllText((Join-Path $rollback.data 'outbox\job-001.lpr'))) -ne 'QUEUED_BEFORE_UPDATE') { throw 'rollback did not restore queued job' }
if (([IO.File]::ReadAllText((Join-Path $rollback.data 'outbox\job-002.lpr'))) -ne 'QUEUED_AFTER_SNAPSHOT') { throw 'rollback lost a job created after snapshot' }

$result = [ordered]@{
    schema = 1
    fromVersion = $FromVersion
    toVersion = $ToVersion
    success = [ordered]@{
        state = $successStatus.state
        helperExitCode = $successRun.exitCode
        elapsedMs = $successRun.elapsedMs
        installedSlintSha256 = $newSlintHash
        installedMaintenanceSha256 = $newHelperHash
        healthConfirmed = $true
        databasePreserved = $true
        outboxPreserved = $true
    }
    rollback = [ordered]@{
        state = $rollbackStatus.state
        helperExitCode = $rollbackRun.exitCode
        elapsedMs = $rollbackRun.elapsedMs
        restoredSlintSha256 = $oldSlintHash
        restoredMaintenanceSha256 = $oldHelperHash
        databaseRestored = $true
        printerSettingsRestored = $true
        preexistingJobRestored = $true
        postSnapshotJobPreserved = $true
    }
}
$resultPath = Join-Path $output 'result.json'
[IO.File]::WriteAllText($resultPath, (($result | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
"NATIVE_UPDATE_E2E_OK from=$FromVersion to=$ToVersion success=$($successRun.elapsedMs)ms rollback=$($rollbackRun.elapsedMs)ms"
"RESULT=$resultPath"
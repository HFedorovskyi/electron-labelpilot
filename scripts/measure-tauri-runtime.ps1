param(
    [ValidateRange(3, 60)][int]$SettleSeconds = 8,
    [ValidateRange(3, 30)][int]$Samples = 5,
    [ValidateRange(250, 5000)][int]$SampleIntervalMs = 1000,
    [ValidateRange(1024, 7680)][int]$WindowWidth = 1366,
    [ValidateRange(640, 4320)][int]$WindowHeight = 768,
    [string]$TauriExe,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($TauriExe)) { $TauriExe = Join-Path $root 'src-tauri\target\release\labelpilot-tauri.exe' }
$TauriExe = [IO.Path]::GetFullPath($TauriExe)
if ([string]::IsNullOrWhiteSpace($OutputPath)) { $OutputPath = Join-Path $root 'artifacts\runtime-benchmark-phase-7-2\runtime-benchmark.json' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
foreach ($path in @($TauriExe)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Runtime executable is missing: $path" }
}

if (-not ('LabelPilotRuntimeWindow' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LabelPilotRuntimeWindow {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
}
"@
}

function Set-TargetWindow([Diagnostics.Process]$Process, [string]$Name) {
    $Process.Refresh()
    if ($Process.MainWindowHandle -eq 0) { throw "$Name has no main window handle" }
    if (-not [LabelPilotRuntimeWindow]::MoveWindow($Process.MainWindowHandle, 0, 0, $WindowWidth, $WindowHeight, $true)) {
        throw "$Name window resize to $WindowWidth x $WindowHeight failed"
    }
    Start-Sleep -Milliseconds 500
}

function Get-ProcessTree([int]$RootPid) {
    $all = @(Get-CimInstance Win32_Process)
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootPid)
    do {
        $added = $false
        foreach ($candidate in $all) {
            if ($ids.Contains([int]$candidate.ParentProcessId) -and $ids.Add([int]$candidate.ProcessId)) { $added = $true }
        }
    } while ($added)
    $rows = @()
    foreach ($processId in $ids) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        $rows += [pscustomobject]@{
            pid = $process.Id
            name = $process.ProcessName
            workingSetBytes = [long]$process.WorkingSet64
            privateBytes = [long]$process.PrivateMemorySize64
            cpuSeconds = if ($null -eq $process.CPU) { 0.0 } else { [double]$process.CPU }
            handles = [int]$process.HandleCount
            threads = [int]$process.Threads.Count
        }
    }
    return $rows
}

function Get-Snapshot([int]$RootPid, [int]$Index) {
    $rows = @(Get-ProcessTree $RootPid)
    if ($rows.Count -eq 0) { throw "Process tree disappeared: $RootPid" }
    return [pscustomobject]@{
        index = $Index
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        processCount = $rows.Count
        workingSetBytes = [long](($rows | Measure-Object workingSetBytes -Sum).Sum)
        privateBytes = [long](($rows | Measure-Object privateBytes -Sum).Sum)
        cpuSeconds = [double](($rows | Measure-Object cpuSeconds -Sum).Sum)
        handles = [int](($rows | Measure-Object handles -Sum).Sum)
        threads = [int](($rows | Measure-Object threads -Sum).Sum)
        processes = $rows
    }
}

function Get-Median([double[]]$Values) {
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count % 2 -eq 1) { return [double]$sorted[[Math]::Floor($sorted.Count / 2)] }
    $right = $sorted.Count / 2
    return ([double]$sorted[$right - 1] + [double]$sorted[$right]) / 2
}

function Start-MeasuredProcess([string]$Name, [string]$Executable, [string]$DataDirectory) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Executable
    $info.WorkingDirectory = Split-Path $Executable -Parent
    $info.UseShellExecute = $false
    $info.EnvironmentVariables['LABELPILOT_DATA_DIR'] = $DataDirectory
    return [Diagnostics.Process]::Start($info)
}

function Stop-MeasuredProcess([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
    try { $Process.WaitForExit(5000) | Out-Null } catch {}
}

function Measure-Runtime([string]$Name, [string]$Executable) {
    $dataDirectory = Join-Path $env:TEMP ("labelpilot-benchmark-$Name-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dataDirectory | Out-Null
    $started = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-MeasuredProcess $Name $Executable $dataDirectory
    $coldStartMs = $null
    $snapshots = @()
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 50
            if ($process.HasExited) { throw "$Name exited during startup with code $($process.ExitCode)" }
            $rootProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
            if ($rootProcess -and $rootProcess.MainWindowHandle -ne 0) { $coldStartMs = $started.Elapsed.TotalMilliseconds; break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($null -eq $coldStartMs) { throw "$Name did not create a main window in 30 seconds" }
        Set-TargetWindow $process $Name
        Start-Sleep -Seconds $SettleSeconds
        $sampleClock = [Diagnostics.Stopwatch]::StartNew()
        for ($index = 0; $index -lt $Samples; $index++) {
            $snapshots += Get-Snapshot $process.Id $index
            if ($index + 1 -lt $Samples) { Start-Sleep -Milliseconds $SampleIntervalMs }
        }
        $sampleClock.Stop()
        $first = $snapshots[0]
        $last = $snapshots[-1]
        $cpuPercent = if ($sampleClock.Elapsed.TotalSeconds -gt 0) {
            [Math]::Round((($last.cpuSeconds - $first.cpuSeconds) / ($sampleClock.Elapsed.TotalSeconds * [Environment]::ProcessorCount)) * 100, 2)
        } else { 0.0 }
        $medianWorking = [long](Get-Median @($snapshots | ForEach-Object { [double]$_.workingSetBytes }))
        $medianPrivate = [long](Get-Median @($snapshots | ForEach-Object { [double]$_.privateBytes }))
        return [pscustomobject]@{
            runtime = $Name
            executable = $Executable
            executableBytes = (Get-Item -LiteralPath $Executable).Length
            dataDirectory = $dataDirectory
            coldStartMs = [Math]::Round($coldStartMs, 1)
            settleSeconds = $SettleSeconds
            sampleCount = $Samples
            medianWorkingSetBytes = $medianWorking
            medianPrivateBytes = $medianPrivate
            peakSampleWorkingSetBytes = [long](($snapshots | Measure-Object workingSetBytes -Maximum).Maximum)
            peakSamplePrivateBytes = [long](($snapshots | Measure-Object privateBytes -Maximum).Maximum)
            idleCpuPercentNormalized = $cpuPercent
            medianProcessCount = [int](Get-Median @($snapshots | ForEach-Object { [double]$_.processCount }))
            medianThreads = [int](Get-Median @($snapshots | ForEach-Object { [double]$_.threads }))
            medianHandles = [int](Get-Median @($snapshots | ForEach-Object { [double]$_.handles }))
            snapshots = $snapshots
        }
    } finally {
        Stop-MeasuredProcess $process
        Start-Sleep -Milliseconds 750
    }
}

$portOwner = Get-NetTCPConnection -State Listen -LocalPort 5556 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portOwner) { throw "Port 5556 is already in use by PID $($portOwner.OwningProcess); stop the active client before benchmark" }
$tauri = Measure-Runtime 'tauri' $TauriExe
$budgets = [ordered]@{ coldStartMs = 2500; idleTreeWorkingSetBytes = 120MB; ordinaryPeakTreePrivateBytes = 200MB; idleCpuPercentNormalized = 5.0 }
$result = [ordered]@{
    schemaVersion = 2
    kind = 'labelpilot-tauri-runtime-benchmark'
    measuredAtUtc = [DateTime]::UtcNow.ToString('o')
    machine = [ordered]@{ logicalProcessors = [Environment]::ProcessorCount; os = [Environment]::OSVersion.VersionString; totalPhysicalMemoryBytes = [long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory }
    method = [ordered]@{ fullProductionUi = $true; isolatedDataDirectories = $true; targetViewport = [ordered]@{ width = $WindowWidth; height = $WindowHeight }; settleSeconds = $SettleSeconds; samples = $Samples; sampleIntervalMs = $SampleIntervalMs; metricsIncludeProcessTree = $true }
    budgets = $budgets
    runtime = $tauri
    gates = [ordered]@{
        tauriColdStart = $tauri.coldStartMs -le $budgets.coldStartMs
        tauriIdleWorkingSet = $tauri.medianWorkingSetBytes -le $budgets.idleTreeWorkingSetBytes
        tauriPeakPrivate = $tauri.peakSamplePrivateBytes -le $budgets.ordinaryPeakTreePrivateBytes
        tauriIdleCpu = $tauri.idleCpuPercentNormalized -le $budgets.idleCpuPercentNormalized
    }
}
$parent = Split-Path $OutputPath -Parent
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$result | ConvertTo-Json -Depth 5

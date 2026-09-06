param(
    [ValidateRange(3, 60)][int]$SettleSeconds = 8,
    [ValidateRange(5, 60)][int]$Samples = 12,
    [ValidateRange(250, 5000)][int]$SampleIntervalMs = 500,
    [string]$SlintExe,
    [string]$TauriBaseline,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($SlintExe)) {
    $SlintExe = Join-Path $PSScriptRoot 'target\release\labelpilot-slint-weighing-poc.exe'
}
if ([string]::IsNullOrWhiteSpace($TauriBaseline)) {
    $TauriBaseline = Join-Path $root 'artifacts\runtime-optimization-phase-7-3\runtime-benchmark.json'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $root 'artifacts\slint-weighing-poc\runtime-comparison.json'
}
$SlintExe = [IO.Path]::GetFullPath($SlintExe)
$TauriBaseline = [IO.Path]::GetFullPath($TauriBaseline)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)

foreach ($path in @($SlintExe, $TauriBaseline)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file is missing: $path" }
}

function Get-ProcessTree([int]$RootPid) {
    $all = @(Get-CimInstance Win32_Process)
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($RootPid)
    do {
        $added = $false
        foreach ($candidate in $all) {
            if ($ids.Contains([int]$candidate.ParentProcessId) -and $ids.Add([int]$candidate.ProcessId)) {
                $added = $true
            }
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

function Stop-Tree([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    try { $Process.Kill($true) } catch { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
    try { $Process.WaitForExit(5000) | Out-Null } catch {}
}

function Measure-Slint([string]$Name, [string]$Mode) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $SlintExe
    $info.WorkingDirectory = Split-Path $SlintExe -Parent
    $info.UseShellExecute = $false
    $info.EnvironmentVariables['SLINT_BACKEND'] = 'winit-femtovg'
    $info.EnvironmentVariables['LABELPILOT_SLINT_WINDOWED'] = '1'
    $info.EnvironmentVariables['LABELPILOT_SLINT_WINDOW_WIDTH'] = '1366'
    $info.EnvironmentVariables['LABELPILOT_SLINT_WINDOW_HEIGHT'] = '768'
    if ($Mode -eq 'live-weight') { $info.EnvironmentVariables['LABELPILOT_SLINT_LIVE_WEIGHT'] = '1' }
    if ($Mode -eq 'native-runtime') { $info.EnvironmentVariables['LABELPILOT_SLINT_NATIVE_RUNTIME'] = '1' }

    $clock = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($info)
    $coldStartMs = $null
    $snapshots = @()
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 25
            if ($process.HasExited) { throw "$Name exited during startup with code $($process.ExitCode)" }
            $current = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
            if ($current -and $current.MainWindowHandle -ne 0) {
                $coldStartMs = $clock.Elapsed.TotalMilliseconds
                break
            }
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($null -eq $coldStartMs) { throw "$Name did not create a window" }

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
            [Math]::Round((($last.cpuSeconds - $first.cpuSeconds) / ($sampleClock.Elapsed.TotalSeconds * [Environment]::ProcessorCount)) * 100, 3)
        } else { 0.0 }

        return [pscustomobject]@{
            runtime = $Name
            executable = $SlintExe
            executableBytes = (Get-Item -LiteralPath $SlintExe).Length
            sha256 = (Get-FileHash -LiteralPath $SlintExe -Algorithm SHA256).Hash.ToLowerInvariant()
            mode = $Mode
            liveWeight120ms = ($Mode -eq 'live-weight')
            nativeRuntime = ($Mode -eq 'native-runtime')
            coldStartMs = [Math]::Round($coldStartMs, 1)
            settleSeconds = $SettleSeconds
            sampleCount = $Samples
            medianWorkingSetBytes = [long](Get-Median @($snapshots | ForEach-Object { [double]$_.workingSetBytes }))
            medianPrivateBytes = [long](Get-Median @($snapshots | ForEach-Object { [double]$_.privateBytes }))
            peakWorkingSetBytes = [long](($snapshots | Measure-Object workingSetBytes -Maximum).Maximum)
            peakPrivateBytes = [long](($snapshots | Measure-Object privateBytes -Maximum).Maximum)
            normalizedCpuPercent = $cpuPercent
            medianProcessCount = [int](Get-Median @($snapshots | ForEach-Object { [double]$_.processCount }))
            medianThreads = [int](Get-Median @($snapshots | ForEach-Object { [double]$_.threads }))
            medianHandles = [int](Get-Median @($snapshots | ForEach-Object { [double]$_.handles }))
            snapshots = $snapshots
        }
    } finally {
        Stop-Tree $process
        Start-Sleep -Milliseconds 500
    }
}

function Get-Reduction([double]$Baseline, [double]$Candidate) {
    if ($Baseline -le 0) { return 0.0 }
    return [Math]::Round((1.0 - ($Candidate / $Baseline)) * 100.0, 1)
}

$baselineDocument = Get-Content -LiteralPath $TauriBaseline -Raw | ConvertFrom-Json
$tauri = if ($baselineDocument.runtimes) {
    @($baselineDocument.runtimes | Where-Object { $_.runtime -eq 'tauri' })[0]
} else {
    $baselineDocument.runtime
}
if (-not $tauri) { throw 'Tauri baseline entry was not found' }

$idle = Measure-Slint 'slint-idle' 'idle'
$live = Measure-Slint 'slint-live-weight' 'live-weight'
$native = Measure-Slint 'slint-native-runtime' 'native-runtime'
$workingReduction = Get-Reduction $tauri.medianWorkingSetBytes $idle.medianWorkingSetBytes
$privateReduction = Get-Reduction $tauri.medianPrivateBytes $idle.medianPrivateBytes
$startReduction = Get-Reduction $tauri.coldStartMs $idle.coldStartMs

$result = [ordered]@{
    schemaVersion = 2
    kind = 'labelpilot-slint-weighing-ui-poc-benchmark'
    measuredAtUtc = [DateTime]::UtcNow.ToString('o')
    machine = [ordered]@{
        logicalProcessors = [Environment]::ProcessorCount
        os = [Environment]::OSVersion.VersionString
        totalPhysicalMemoryBytes = [long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    }
    method = [ordered]@{
        targetViewport = [ordered]@{ width = 1366; height = 768 }
        renderer = 'winit-femtovg'
        processTreeMetrics = $true
        slintScope = 'interactive weighing UI PoC: idle, synthetic 120 ms updates, and shared production Rust scale/printer core without WebView2'
        tauriScope = 'existing full production runtime baseline including Rust core and WebView2'
        tauriBaselinePath = $TauriBaseline
        settleSeconds = $SettleSeconds
        samples = $Samples
        sampleIntervalMs = $SampleIntervalMs
    }
    tauriBaseline = $tauri
    slintIdle = $idle
    slintLiveWeight = $live
    slintNativeRuntime = $native
    comparison = [ordered]@{
        idleWorkingSetReductionPercent = $workingReduction
        idlePrivateBytesReductionPercent = $privateReduction
        coldStartReductionPercent = $startReduction
        processCountReduction = [int]$tauri.medianProcessCount - [int]$idle.medianProcessCount
        liveWeightCpuDeltaPercent = [Math]::Round($live.normalizedCpuPercent - $idle.normalizedCpuPercent, 3)
        nativeRuntimeWorkingSetOverheadBytes = [long]$native.medianWorkingSetBytes - [long]$idle.medianWorkingSetBytes
        nativeRuntimePrivateOverheadBytes = [long]$native.medianPrivateBytes - [long]$idle.medianPrivateBytes
        nativeRuntimeCpuDeltaPercent = [Math]::Round($native.normalizedCpuPercent - $idle.normalizedCpuPercent, 3)
        nativeWorkingSetReductionVsTauriPercent = (Get-Reduction $tauri.medianWorkingSetBytes $native.medianWorkingSetBytes)
        nativePrivateReductionVsTauriPercent = (Get-Reduction $tauri.medianPrivateBytes $native.medianPrivateBytes)
    }
    decisionGate = [ordered]@{
        significant = ((Get-Reduction $tauri.medianWorkingSetBytes $native.medianWorkingSetBytes) -ge 50 -and (Get-Reduction $tauri.medianPrivateBytes $native.medianPrivateBytes) -ge 40 -and $native.normalizedCpuPercent -le 2.0)
        minimumWorkingSetReductionPercent = 50
        minimumPrivateBytesReductionPercent = 40
        maximumLiveWeightCpuPercent = 2.0
    }
}

$parent = Split-Path $OutputPath -Parent
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$result | ConvertTo-Json -Depth 9 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$result | ConvertTo-Json -Depth 5

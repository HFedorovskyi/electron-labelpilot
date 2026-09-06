[CmdletBinding()]
param(
    [string]$Executable = 'src-tauri/target/release/labelpilot-tauri.exe',
    [string]$OutputDirectory = 'artifacts/slint-default-2.0.3/runtime-e2e'
)

$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repo
$phaseRoot = [IO.Path]::GetFullPath((Join-Path $repo 'artifacts\slint-default-2.0.3'))
$output = [IO.Path]::GetFullPath((Join-Path $repo $OutputDirectory))
$prefix = $phaseRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "runtime E2E output must remain inside $phaseRoot"
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$executablePath = [IO.Path]::GetFullPath((Join-Path $repo $Executable))
$sidecarPath = Join-Path (Split-Path -Parent $executablePath) 'labelpilot-slint.exe'
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw "dispatcher missing: $executablePath" }
if (-not (Test-Path -LiteralPath $sidecarPath -PathType Leaf)) { throw "Slint sidecar missing: $sidecarPath" }

$probe = Join-Path $output 'default-runtime.json'
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $executablePath
$info.Arguments = "--runtime-probe=`"$probe`""
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.EnvironmentVariables.Remove('LABELPILOT_UI_RUNTIME')
$info.EnvironmentVariables.Remove('LABELPILOT_UI_FALLBACK')
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$started = [DateTimeOffset]::UtcNow
if (-not $process.Start()) { throw 'dispatcher did not start' }
if (-not $process.WaitForExit(15000)) {
    try { $process.Kill() } catch {}
    throw 'runtime probe timed out after 15 seconds'
}
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "runtime probe exited with $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) { throw 'runtime probe JSON missing' }
$value = Get-Content -LiteralPath $probe -Raw | ConvertFrom-Json
if ([string]$value.selectedRuntime -ne 'slint') { throw "default runtime is $($value.selectedRuntime)" }
if ([string]$value.selectionSource -ne 'default') { throw "selection source is $($value.selectionSource)" }
if (-not [bool]$value.fallbackEnabled) { throw 'Tauri fallback is disabled' }
if (-not [bool]$value.slintSidecarAvailable) { throw 'Slint sidecar is not available to dispatcher' }
$result = [ordered]@{
    schema = 1
    version = '2.0.3'
    selectedRuntime = [string]$value.selectedRuntime
    selectionSource = [string]$value.selectionSource
    fallbackEnabled = [bool]$value.fallbackEnabled
    slintSidecarAvailable = [bool]$value.slintSidecarAvailable
    elapsedMs = [Math]::Round(([DateTimeOffset]::UtcNow - $started).TotalMilliseconds)
}
$resultPath = Join-Path $output 'result.json'
[IO.File]::WriteAllText($resultPath, (($result | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))
"SLINT_DEFAULT_RUNTIME_E2E_OK version=2.0.3 selected=slint source=default fallback=tauri elapsed=$($result.elapsedMs)ms"
"RESULT=$resultPath"
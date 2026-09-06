$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dir = Join-Path $root 'artifacts\printer-diagnostics-phase-7-1'
$log = [Text.StringBuilder]::new()
[void]$log.AppendLine('LabelPilot printer diagnostics phase 7.1 verification')
[void]$log.AppendLine("Timestamp: $([DateTimeOffset]::Now.ToString('o'))")
[void]$log.AppendLine("Workspace: $root")
function Run-Native([string]$label, [string]$file, [string[]]$arguments) {
    [void]$log.AppendLine("`r`nCOMMAND> $label")
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $file @arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    [void]$log.Append($output)
    [void]$log.AppendLine("EXIT_CODE=$code")
    if ($code -ne 0) { [IO.File]::WriteAllText((Join-Path $dir 'verification.log'), $log.ToString()); throw "$label failed: $code" }
}
$baselinePath = Join-Path $dir 'labelpilot-tauri.previous.exe'
$modifiedPath = Join-Path $dir 'labelpilot-tauri.exe'
$patchPath = Join-Path $dir 'printer-diagnostics-phase-7-1.patch'
foreach ($item in @(@('BASELINE_INPUT',$baselinePath),@('MODIFIED_INPUT',$modifiedPath),@('PATCH_INPUT',$patchPath))) {
    $hash = (Get-FileHash -LiteralPath $item[1] -Algorithm SHA256).Hash
    [void]$log.AppendLine("`r`nCOMMAND> Get-FileHash -Algorithm SHA256 -LiteralPath '$($item[1])'")
    [void]$log.AppendLine("$($item[0]) SHA256=$hash")
    [void]$log.AppendLine('EXIT_CODE=0')
}
Run-Native 'npm.cmd run test:migration' 'npm.cmd' @('run','test:migration')
Run-Native 'cargo test --manifest-path src-tauri/Cargo.toml' 'cargo' @('test','--manifest-path','src-tauri/Cargo.toml')
Run-Native 'npm.cmd run build' 'npm.cmd' @('run','build')
Run-Native 'node scripts/test-tauri-runtime.cjs' 'node' @('scripts/test-tauri-runtime.cjs')
Run-Native "node scripts/smoke-tauri-printer-diagnostics.cjs '$modifiedPath' runtime-smoke.json" 'node' @('scripts/smoke-tauri-printer-diagnostics.cjs',$modifiedPath,(Join-Path $dir 'runtime-smoke.json'))
$validation = Join-Path $dir 'rollback-validation\labelpilot-tauri.exe'
Copy-Item -LiteralPath $modifiedPath -Destination $validation -Force
Run-Native "powershell.exe -File rollback.ps1 -TargetPath '$validation'" 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $dir 'rollback.ps1'),'-TargetPath',$validation)
$rolled = (Get-FileHash -LiteralPath $validation -Algorithm SHA256).Hash
$baseline = (Get-FileHash -LiteralPath $baselinePath -Algorithm SHA256).Hash
if ($rolled -ne $baseline) { throw 'rollback hash comparison failed' }
[void]$log.AppendLine("ROLLBACK_BEHAVIOR baseline-restored=true SHA256=$rolled")
[void]$log.AppendLine('EXIT_CODE=0')
[IO.File]::WriteAllText((Join-Path $dir 'verification.log'), $log.ToString(), [Text.UTF8Encoding]::new($true))
Write-Output "VERIFICATION_LOG=$(Join-Path $dir 'verification.log')"
Write-Output "VERIFICATION_BYTES=$((Get-Item (Join-Path $dir 'verification.log')).Length)"

# Deadline for a step that cannot carry its own timeout (#626): composite steps take no `timeout-minutes`, and the
# `Vampire/setup-wsl` step is a third-party action. Started detached before the step, signalled by `-StateDirectory`
# files, it kills the stuck WSL processes at the deadline so the step fails with a report instead of hanging.
#
# The caller must start it outside the runner's process tree (`Win32_Process.Create`): run 42756515991 launched it with
# `Start-Process` and it was gone when `setup-wsl` ended 2646s later, with empty logs and no trip.
# Files in the state directory: `watchdog.done` (the step finished; written by the caller), `watchdog.tripped`
# (written here), `watchdog.alive` (a unix timestamp refreshed every loop, so the caller can prove the timer is armed
# and see when it last ran) and `watchdog.pid`.
param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][int]$Seconds,
    [Parameter(Mandatory = $true)][string]$StateDirectory
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'wsl2_bounded.ps1')
$done = Join-Path $StateDirectory 'watchdog.done'
$alive = Join-Path $StateDirectory 'watchdog.alive'
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    # A sharing violation with the stop step's read must not kill the timer.
    Set-Content -ErrorAction SilentlyContinue -Path $alive -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
    if (Test-Path $done) { exit 0 }
    Start-Sleep -Seconds 2
}
if (Test-Path $done) { exit 0 }
Set-Content -Path (Join-Path $StateDirectory 'watchdog.tripped') -Value $Label
Write-Host "::error title=WSL setup timed out::$Label exceeded ${Seconds}s and is being killed"
Write-StallReport
# The leaf `wsl.exe` calls and the action's own node process are what a hang sits in; killing them fails the step.
$null = Invoke-Limited -FilePath 'wsl' -Arguments @('--shutdown') -Seconds 20
Get-CimInstance Win32_Process |
    Where-Object { $_.Name -in 'wsl.exe', 'wslhost.exe' -or ($_.Name -eq 'node.exe' -and "$($_.CommandLine)" -match 'setup-wsl') } |
    ForEach-Object {
        Write-Host "killing $($_.Name) $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

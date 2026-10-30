# Execute an ordinary CI run step in the persistent Linux guest, never on Windows.
param([Parameter(Mandatory = $true)][string]$Script)
$ErrorActionPreference = 'Stop'
$env:WSL_HOST_WORKSPACE = $env:GITHUB_WORKSPACE
$env:WSL_HOST_TEMP = $env:RUNNER_TEMP
$env:WSL_STEP_SCRIPT = $Script
$env:WSL_STEP_DIRECTORY = [System.IO.Path]::GetRelativePath($env:GITHUB_WORKSPACE, (Get-Location).Path).Replace('\', '/')
# Explicit allowlist: paths translate, scalar values do not. No general environment dump.
$env:WSLENV = 'WSL_HOST_WORKSPACE/p:WSL_HOST_TEMP/p:WSL_STEP_SCRIPT/p:WSL_STEP_DIRECTORY:GH_TOKEN/u:GITHUB_OUTPUT/p:GITHUB_ENV/p:GITHUB_STEP_SUMMARY/p:GITHUB_EVENT_PATH/p:GITHUB_EVENT_NAME:GITHUB_ACTIONS:CI:BASE:PI_BIN:PI_CU_LINUX_ARM64_CHECK'
$adapterOutput = & wsl -d Ubuntu-24.04 --exec wslpath -u "$env:GITHUB_WORKSPACE/scripts/wsl2_run.sh"
$status = $LASTEXITCODE
if ($status -ne 0) {
    [Console]::Error.WriteLine("wsl2-shell: wslpath failed with status $status")
    exit $status
}
$adapter = $adapterOutput.Trim()
& wsl -d Ubuntu-24.04 --user pi-ci --exec bash -euo pipefail "$adapter"
$status = $LASTEXITCODE
if ($status -ne 0) {
    [Console]::Error.WriteLine("wsl2-shell: guest dispatch failed with status $status")
}
exit $status

# Credential-free Windows control fixture for #753. Only synthetic processes are visible to the watchdog.
# Run Arm and Trip in separate Actions steps to test the real detached launch across the step boundary.
param(
    [Parameter(Mandatory = $true)][ValidateSet('Arm', 'Trip', 'Done', 'Cancelled', 'Unarmed', 'Posthoc')][string]$Phase
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP 'watchdog-control-fixture'
$receiptDir = Join-Path $root 'receipts'
$productionRoot = Split-Path $PSScriptRoot
$node = (Get-Command node.exe -CommandType Application).Source
New-Item -ItemType Directory -Force $receiptDir | Out-Null

function Assert-Control([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "Control assertion failed: $Label" }
}

function Write-Receipt([hashtable]$Values) {
    # No environment, command lines, process IDs or raw host/guest snapshots enter the artifact.
    $Values.phase = $Phase
    $Values | ConvertTo-Json | Set-Content (Join-Path $receiptDir "$Phase.json")
}

function Set-FixtureEnvironment([string]$Directory) {
    $env:GITHUB_WORKSPACE = $Directory
    $env:RUNNER_TEMP = $Directory
    $env:PATH = "$Directory;$env:PATH"
}

function New-Case([string]$Name) {
    $dir = Join-Path $root $Name
    New-Item -ItemType Directory -Force (Join-Path $dir 'scripts') | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $dir 'wsl2-diagnostics') | Out-Null
    '[]' | Set-Content (Join-Path $dir 'children.json')
    Copy-Item $node (Join-Path $dir 'wsl.exe')
    $actual = (Join-Path $productionRoot 'scripts/wsl2_watchdog.ps1').Replace("'", "''")
    $wrapper = @'
param([string]$Label, [int]$Seconds, [string]$StateDirectory)
$ErrorActionPreference = 'Stop'
$fixtureRoot = Split-Path $StateDirectory
$shim = (Get-Command wsl.exe -CommandType Application).Source
if ($shim -ne (Join-Path $fixtureRoot 'wsl.exe')) { throw 'Fixture WSL shim not selected' }
$fixtureChildren = @(Get-Content (Join-Path $fixtureRoot 'children.json') | ConvertFrom-Json)
function Start-Process {
    param([string]$FilePath, [string[]]$ArgumentList, [switch]$NoNewWindow, [switch]$PassThru, [string]$RedirectStandardOutput)
    # Redirect only the WSL executable boundary; exercise the real Invoke-Limited process/deadline implementation.
    if ($FilePath -ne 'wsl') { throw 'Unexpected fixture executable' }
    $PSBoundParameters.FilePath = $shim
    Microsoft.PowerShell.Management\Start-Process @PSBoundParameters
}
function Get-CimInstance {
    param([string]$ClassName)
    # Real Windows records, restricted to the two explicitly owned synthetic children. Never enumerate the host.
    if ($fixtureChildren.Count -eq 0) { return }
    CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter "ProcessId = $($fixtureChildren[0]) OR ProcessId = $($fixtureChildren[1])"
}
function Write-Host {
    param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Objects)
    # Expected timeout annotations must not turn the control test into a reported job error.
    if (($Objects -join ' ') -like '::error*') { Microsoft.PowerShell.Utility\Write-Host 'EXPECTED_SYNTHETIC_TIMEOUT' }
}
. '__WATCHDOG__' -Label $Label -Seconds $Seconds -StateDirectory $StateDirectory
'@
    $wrapper.Replace('__WATCHDOG__', $actual) | Set-Content (Join-Path $dir 'scripts/wsl2_watchdog.ps1')
    & python (Join-Path $productionRoot 'scripts/wsl2_watchdog_fixture.py') (Join-Path $productionRoot '.github/actions/setup-ci-wsl/action.yml') $dir
    Assert-Control ($LASTEXITCODE -eq 0) 'extract production launch/report blocks'
    return $dir
}

function Invoke-ExpectedReport([string]$Directory, [string]$Message) {
    $caught = $false
    try { & (Join-Path $Directory 'report.ps1') }
    catch {
        Assert-Control ($_.Exception.Message.Contains($Message)) 'exact expected report failure'
        $caught = $true
    }
    Assert-Control $caught 'report must reject the synthetic failure'
}

trap {
    Write-Receipt @{ outcome = 'unexpected_control_failure' }
    throw
}
Write-Receipt @{ outcome = 'started' }

if ($Phase -eq 'Arm') {
    $dir = New-Case 'trip'
    # Node is preinstalled on windows-2025. No package installation, tokens, WSL distro or provider is used.
    Set-Content (Join-Path $dir 'setup-wsl-fixture.js') 'setInterval(() => {}, 1000);'
    Set-Content (Join-Path $dir 'sentinel.js') 'setInterval(() => {}, 1000);'
    $children = @()
    try {
        foreach ($file in @('setup-wsl-fixture.js', 'sentinel.js')) {
            $command = '"{0}" "{1}"' -f $node, (Join-Path $dir $file)
            $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $dir }
            Assert-Control ($created.ReturnValue -eq 0) 'start synthetic child'
            $children += [int]$created.ProcessId
        }
        $children | ConvertTo-Json | Set-Content (Join-Path $dir 'children.json')
        Set-FixtureEnvironment $dir
        & (Join-Path $dir 'launch.ps1')
        $state = Join-Path $dir 'wsl2-diagnostics'
        Assert-Control (Test-Path (Join-Path $state 'watchdog.alive')) 'real detached watchdog armed'
        Assert-Control (Test-Path (Join-Path $state 'watchdog.started')) 'launch clock retained'
        $initial = Get-Content (Join-Path $state 'watchdog.alive')
        $heartbeatDeadline = (Get-Date).AddSeconds(6)
        do {
            Start-Sleep -Milliseconds 200
            $current = Get-Content (Join-Path $state 'watchdog.alive')
        } while ($current -eq $initial -and (Get-Date) -lt $heartbeatDeadline)
        Assert-Control ($current -ne $initial) 'detached heartbeat advances'
        Assert-Control (-not (Test-Path (Join-Path $state 'watchdog.tripped'))) 'leave arm step before deadline'
        Write-Receipt @{ armed = $true; heartbeatAdvanced = $true; detached = $true; deadlineSeconds = 12 }
    }
    catch {
        foreach ($childId in $children) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }
        throw
    }
}
elseif ($Phase -eq 'Trip') {
    $dir = Join-Path $root 'trip'
    Set-FixtureEnvironment $dir
    $children = Get-Content (Join-Path $dir 'children.json') | ConvertFrom-Json
    $state = Join-Path $dir 'wsl2-diagnostics'
    try {
        $deadline = (Get-Date).AddSeconds(75)
        while ((Get-Date) -lt $deadline -and (Get-Process -Id $children[0] -ErrorAction SilentlyContinue)) {
            Start-Sleep -Milliseconds 200
        }
        Assert-Control (Test-Path (Join-Path $state 'watchdog.tripped')) 'deadline tripped across step boundary'
        Assert-Control (-not (Get-Process -Id $children[0] -ErrorAction SilentlyContinue)) 'watchdog killed stalled setup child'
        Assert-Control ($null -ne (Get-Process -Id $children[1] -ErrorAction SilentlyContinue)) 'unrelated sentinel survives'
        Invoke-ExpectedReport $dir 'WSL setup was killed by its watchdog'
        Write-Receipt @{ tripped = $true; ownedChildKilled = $true; sentinelSurvived = $true; reportRejected = $true }
    }
    finally {
        foreach ($childId in $children) { Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue }
    }
}
elseif ($Phase -in 'Done', 'Cancelled') {
    $dir = New-Case $Phase
    # These cases run the same isolated actual watchdog, which must observe done before diagnostic/kill calls.
    Set-FixtureEnvironment $dir
    $cancelled = $false
    & (Join-Path $dir 'launch.ps1')
    try {
        if ($Phase -eq 'Cancelled') { throw 'SYNTHETIC_CALLER_CANCELLED' }
    }
    catch {
        Assert-Control ($_.Exception.Message -eq 'SYNTHETIC_CALLER_CANCELLED') 'caller cancellation owned by caller'
        $cancelled = $true
    }
    finally { & (Join-Path $dir 'report.ps1') }
    $state = Join-Path $dir 'wsl2-diagnostics'
    Assert-Control (Test-Path (Join-Path $state 'watchdog.done')) 'caller cleanup signals done'
    Assert-Control (-not (Test-Path (Join-Path $state 'watchdog.tripped'))) 'done prevents trip'
    Write-Receipt @{ done = $true; tripped = $false; syntheticCallerCancellation = $cancelled }
}
elseif ($Phase -eq 'Unarmed') {
    $dir = New-Case 'unarmed'
    Set-Content (Join-Path $dir 'scripts/wsl2_watchdog.ps1') 'exit 0'
    Set-FixtureEnvironment $dir
    $caught = $false
    try { & (Join-Path $dir 'launch.ps1') }
    catch {
        Assert-Control ($_.Exception.Message.Contains('The watchdog never armed')) 'exact arm refusal'
        $caught = $true
    }
    Assert-Control $caught 'missing heartbeat fails launch'
    Write-Receipt @{ missingHeartbeatRejected = $true }
}
else {
    $dir = New-Case 'posthoc'
    Set-FixtureEnvironment $dir
    $state = Join-Path $dir 'wsl2-diagnostics'
    New-Item -ItemType Directory -Force $state | Out-Null
    # Inject the clock state, not a 45-minute wait. No watchdog or child process exists in this case.
    Set-Content (Join-Path $state 'watchdog.started') @(([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 50), 12)
    Set-Content (Join-Path $state 'watchdog.alive') '0'
    Invoke-ExpectedReport $dir 'the watchdog did not trip'
    Write-Receipt @{ staleClockRejected = $true; watchdogAbsent = $true }
}

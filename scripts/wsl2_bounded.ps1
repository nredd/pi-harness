# Bounded host-side commands for WSL guest setup (#626). Dot-source this file.
#
# A hung `wsl.exe` call used to burn the whole 45 minute job timeout and lose the job log with it. These helpers
# give each command a deadline sized from hosted passes, and print the stuck command and a process snapshot when
# it trips, so the step fails in minutes with a cause.
$ErrorActionPreference = 'Stop'

function Invoke-Limited {
    <#
    .SYNOPSIS
        Run one program with a deadline, killing its process tree when it trips.
    .OUTPUTS
        PSCustomObject with TimedOut and ExitCode (124 when timed out).
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][int]$Seconds,
        [string]$OutFile
    )
    $start = @{ FilePath = $FilePath; ArgumentList = $Arguments; NoNewWindow = $true; PassThru = $true }
    if ($OutFile) { $start.RedirectStandardOutput = $OutFile }
    $process = Start-Process @start
    # Cache the handle so ExitCode stays readable after exit.
    $null = $process.Handle
    if ($process.WaitForExit($Seconds * 1000)) {
        $process.WaitForExit()
        return [pscustomobject]@{ TimedOut = $false; ExitCode = $process.ExitCode }
    }
    $process.Kill($true)
    return [pscustomobject]@{ TimedOut = $true; ExitCode = 124 }
}

function Write-StallReport {
    <#
    .SYNOPSIS
        Print what the host and the guest were running, for a command that did not finish.
    #>
    Write-Host '--- host processes, oldest first'
    Get-CimInstance Win32_Process |
        Where-Object { $_.ProcessId -ne $PID } |
        Sort-Object CreationDate |
        Select-Object -First 40 ProcessId, ParentProcessId, Name, CreationDate, @{ n = 'Command'; e = { "$($_.CommandLine)".Substring(0, [Math]::Min(200, "$($_.CommandLine)".Length)) } } |
        Format-List | Out-String -Width 300 | Write-Host
    Write-Host '--- wsl --list --verbose'
    $listing = Join-Path ([System.IO.Path]::GetTempPath()) 'wsl2-stall-list.txt'
    $null = Invoke-Limited -FilePath 'wsl' -Arguments @('--list', '--verbose') -Seconds 20 -OutFile $listing
    if (Test-Path $listing) { ((Get-Content -Raw $listing) -replace ([char]0), '') | Write-Host }
    Write-Host '--- guest processes, longest running first'
    $guest = Join-Path ([System.IO.Path]::GetTempPath()) 'wsl2-stall-guest.txt'
    $result = Invoke-Limited -FilePath 'wsl' -Arguments @('-d', 'Ubuntu-24.04', '--user', 'root', '--exec', 'ps', '-eo', 'pid,ppid,etime,stat,args', '--sort=-etime') -Seconds 20 -OutFile $guest
    if ($result.TimedOut) { Write-Host 'guest did not answer within 20s' }
    elseif (Test-Path $guest) { Get-Content $guest -TotalCount 40 | Write-Host }
}

function Invoke-Bounded {
    <#
    .SYNOPSIS
        Run a command under a deadline. Sets $LASTEXITCODE like a native call; a trip fails with 124.
    .PARAMETER Label
        Names the command in the failure message.
    .PARAMETER Seconds
        Deadline.
    .PARAMETER Capture
        Return the command's standard output instead of streaming it, with NUL bytes removed.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][int]$Seconds,
        [switch]$Capture,
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Command
    )
    $outFile = if ($Capture) { [System.IO.Path]::GetTempFileName() } else { $null }
    $result = Invoke-Limited -FilePath $Command[0] -Arguments $Command[1..($Command.Count - 1)] -Seconds $Seconds -OutFile $outFile
    $captured = if ($Capture -and (Test-Path $outFile)) { (Get-Content -Raw $outFile) -replace ([char]0), '' } else { $null }
    if ($result.TimedOut) {
        Write-Host "::error title=WSL setup timed out::$Label exceeded ${Seconds}s: $($Command -join ' ')"
        if ($captured) { Write-Host "--- output before the timeout`n$captured" }
        Write-StallReport
    }
    $global:LASTEXITCODE = $result.ExitCode
    if ($Capture) { return $captured }
}

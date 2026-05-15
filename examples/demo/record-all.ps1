# Records each of the three Guardian-Agent demos with PowerSession,
# then renders each .cast to .gif with agg. Output filenames mirror the
# source .ts demo scripts so the relationship is obvious in a directory listing.
#
# Run from an interactive PowerShell window — PowerSession needs a real PTY,
# which a sandboxed shell does not provide.
#
# Usage:
#   cd C:\Users\Arcade\FlowdotPlatform\guardian-agent-ts\examples\demo
#   .\record-all.ps1

$ErrorActionPreference = 'Stop'

# Make sure the freshly-installed binaries are on PATH for this session.
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$demos = @(
    @{ Name = 'demo-1-tamper';      Script = 'npm run demo:1' },
    @{ Name = 'demo-2-gate';        Script = 'npm run demo:2' },
    @{ Name = 'demo-3-honeytoken';  Script = 'npm run demo:3' }
)

foreach ($d in $demos) {
    $cast = "$($d.Name).cast"
    $gif  = "$($d.Name).gif"
    Write-Host ""
    Write-Host "==================================================" -ForegroundColor Cyan
    Write-Host " Recording $($d.Name)" -ForegroundColor Cyan
    Write-Host "==================================================" -ForegroundColor Cyan
    Remove-Item $cast, $gif -ErrorAction SilentlyContinue
    PowerSession rec $cast --command "cmd /c $($d.Script)" --force
    if (-not (Test-Path $cast)) {
        Write-Host "FAILED to produce $cast" -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "Rendering $cast -> $gif"
    agg --font-size 20 $cast $gif
    if (-not (Test-Path $gif)) {
        Write-Host "FAILED to produce $gif" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host " All three demos recorded + rendered." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Get-ChildItem demo-*.cast, demo-*.gif | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

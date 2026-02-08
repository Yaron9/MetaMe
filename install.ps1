# MetaMe Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  MetaMe - Your AI Shadow" -ForegroundColor Cyan
Write-Host "  Windows Installer (via WSL)" -ForegroundColor DarkGray
Write-Host ""

# -----------------------------------------------------------
# 1. Check if WSL is available
# -----------------------------------------------------------
$wslInstalled = $false
try {
    $wslOutput = wsl --status 2>&1
    if ($LASTEXITCODE -eq 0 -or ($wslOutput -match "Default Distribution")) {
        $wslInstalled = $true
    }
} catch {}

if (-not $wslInstalled) {
    try {
        $distros = wsl --list --quiet 2>&1
        if ($distros -and $distros.Length -gt 0 -and $LASTEXITCODE -eq 0) {
            $wslInstalled = $true
        }
    } catch {}
}

if (-not $wslInstalled) {
    Write-Host "[1/3] Installing WSL..." -ForegroundColor Yellow
    Write-Host "  This requires administrator privileges." -ForegroundColor DarkGray
    Write-Host ""

    # Check if running as admin
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if (-not $isAdmin) {
        Write-Host "  Please run this command in an Administrator PowerShell:" -ForegroundColor Red
        Write-Host ""
        Write-Host "  irm https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.ps1 | iex" -ForegroundColor White
        Write-Host ""
        Write-Host "  Or install WSL manually first:" -ForegroundColor DarkGray
        Write-Host "  wsl --install" -ForegroundColor White
        Write-Host ""
        exit 1
    }

    wsl --install -d Ubuntu
    Write-Host ""
    Write-Host "  WSL + Ubuntu installed." -ForegroundColor Green
    Write-Host ""
    Write-Host "  IMPORTANT: You must RESTART your computer now." -ForegroundColor Yellow
    Write-Host "  After reboot, open Ubuntu from Start Menu to finish setup," -ForegroundColor Yellow
    Write-Host "  then re-run this installer." -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

Write-Host "[OK] WSL is installed" -ForegroundColor Green

# -----------------------------------------------------------
# 2. Run the bash installer inside WSL
# -----------------------------------------------------------
Write-Host "[2/3] Running MetaMe installer inside WSL..." -ForegroundColor Cyan
Write-Host ""

wsl bash -c "curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  Installation failed inside WSL." -ForegroundColor Red
    Write-Host "  Try running manually: wsl bash -c 'curl -fsSL https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.sh | bash'" -ForegroundColor DarkGray
    exit 1
}

# -----------------------------------------------------------
# 3. Create Windows shortcut
# -----------------------------------------------------------
Write-Host ""
Write-Host "[3/3] Setting up Windows access..." -ForegroundColor Cyan

# Add a batch wrapper so `metame` works from PowerShell/CMD too
$wrapperDir = Join-Path $env:LOCALAPPDATA "MetaMe"
if (-not (Test-Path $wrapperDir)) { New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null }

$wrapperPath = Join-Path $wrapperDir "metame.cmd"
Set-Content -Path $wrapperPath -Value "@echo off`r`nwsl bash -ic 'metame %*'"

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$wrapperDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$wrapperDir", "User")
    Write-Host "  Added metame to PATH (restart terminal to use)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Usage:" -ForegroundColor White
Write-Host "    From PowerShell/CMD:  metame" -ForegroundColor Cyan
Write-Host "    From WSL terminal:    metame" -ForegroundColor Cyan
Write-Host ""
Write-Host "  First launch will guide you through setup." -ForegroundColor DarkGray
Write-Host ""

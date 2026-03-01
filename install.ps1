# MetaMe Installer for Windows
# Usage: irm https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  MetaMe - Your Digital Twin" -ForegroundColor Cyan
Write-Host "  Windows Installer" -ForegroundColor DarkGray
Write-Host ""

$MIN_NODE_VERSION = 18

# -----------------------------------------------------------
# 1. Check / Install Node.js
# -----------------------------------------------------------
$nodeInstalled = $false
try {
    $nodeVer = (node -v 2>$null)
    if ($nodeVer) {
        $major = [int]($nodeVer -replace '^v','').Split('.')[0]
        if ($major -ge $MIN_NODE_VERSION) {
            Write-Host "[OK] Node.js $nodeVer found" -ForegroundColor Green
            $nodeInstalled = $true
        } else {
            Write-Host "[!] Node.js $nodeVer is too old (need >= $MIN_NODE_VERSION)" -ForegroundColor Yellow
        }
    }
} catch {}

if (-not $nodeInstalled) {
    Write-Host "[1/3] Installing Node.js..." -ForegroundColor Cyan

    # Try winget first
    $hasWinget = $false
    try { winget --version 2>$null; if ($LASTEXITCODE -eq 0) { $hasWinget = $true } } catch {}

    if ($hasWinget) {
        Write-Host "  Installing via winget..." -ForegroundColor DarkGray
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    } else {
        # Download Node.js MSI installer
        Write-Host "  Downloading Node.js installer..." -ForegroundColor DarkGray
        $nodeUrl = "https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi"
        $msiPath = Join-Path $env:TEMP "node-install.msi"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "  Running installer..." -ForegroundColor DarkGray
        Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Wait
        Remove-Item $msiPath -ErrorAction SilentlyContinue
    }

    # Refresh PATH so node/npm are available in this session
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"

    try {
        $nodeVer = (node -v 2>$null)
        if ($nodeVer) {
            Write-Host "[OK] Node.js $nodeVer installed" -ForegroundColor Green
        } else {
            throw "not found"
        }
    } catch {
        Write-Host ""
        Write-Host "  Node.js installation requires a terminal restart." -ForegroundColor Yellow
        Write-Host "  Please close this terminal, open a new one, and re-run:" -ForegroundColor Yellow
        Write-Host "  irm https://raw.githubusercontent.com/Yaron9/MetaMe/main/install.ps1 | iex" -ForegroundColor White
        Write-Host ""
        exit 0
    }
}

# -----------------------------------------------------------
# 2. Install Claude Code
# -----------------------------------------------------------
$hasClaudeCode = $false
try { claude -v 2>$null; if ($LASTEXITCODE -eq 0) { $hasClaudeCode = $true } } catch {}

if ($hasClaudeCode) {
    Write-Host "[OK] Claude Code already installed" -ForegroundColor Green
} else {
    Write-Host "[2/3] Installing Claude Code..." -ForegroundColor Cyan
    npm install -g @anthropic-ai/claude-code
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Claude Code installation failed. Try manually: npm install -g @anthropic-ai/claude-code" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Claude Code installed" -ForegroundColor Green
}

# -----------------------------------------------------------
# 3. Install MetaMe
# -----------------------------------------------------------
Write-Host "[3/3] Installing MetaMe..." -ForegroundColor Cyan
npm install -g metame-cli
if ($LASTEXITCODE -ne 0) {
    Write-Host "  MetaMe installation failed. Try manually: npm install -g metame-cli" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] MetaMe installed" -ForegroundColor Green

# -----------------------------------------------------------
# Done
# -----------------------------------------------------------
Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Run:" -ForegroundColor White
Write-Host "    metame          - Start MetaMe" -ForegroundColor Cyan
Write-Host "    claude          - Start Claude Code" -ForegroundColor Cyan
Write-Host ""
Write-Host "  First launch will guide you through setup." -ForegroundColor DarkGray
Write-Host ""

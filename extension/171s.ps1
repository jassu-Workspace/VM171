#Requires -Version 5.1
<#
.SYNOPSIS
    SIH Zero-Trust AI Web Agent - DEVELOPMENT launcher.

.DESCRIPTION
    Starts the server in watch mode and the WXT dev server, for iterating on
    the extension. For a production stack use ..\s.ps1 instead.

.NOTES
    Updated for the security work. What it previously got wrong:

    1. Its Ctrl+C handler never fired. It registered
       `PowerShell.Exiting`, which is not raised for a console Ctrl+C, so the
       cleanup code it advertised was unreachable and both child processes were
       left running. It now traps Ctrl+C via try/finally, which PowerShell
       does guarantee.

    2. It declared success after `Start-Sleep -Seconds 2` without ever
       checking that the server had started. The server exits on a missing
       SECRET_PASSWORD or a missing provider, so the old script would cheerfully
       print "STACK IS LIVE" over a process that had already died.

    3. It never mentioned pairing, so a dev could not authenticate the
       extension against their own server.

    4. It used `npm install` rather than `npm ci`, so a lockfile change could
       silently not be applied.

.EXAMPLE
    .\171s.ps1
.EXAMPLE
    .\171s.ps1 -ServerPort 4000
#>

param(
    [int]$ServerPort = 3000,
    [string]$ServerDir = "..\server",
    [string]$ExtensionDir = "..\extension"
)

$ErrorActionPreference = "Stop"
$serverProc = $null
$extensionProc = $null

function Write-ColorText {
    param([string]$Text, [string]$Color = "White")
    Write-Host $Text -ForegroundColor $Color
}

function Stop-AllProcesses {
    # Idempotent: this runs from the finally block, and may run twice if the
    # user also interrupts during cleanup.
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        Stop-Process -Id $script:serverProcess.Id -Force -ErrorAction SilentlyContinue
        Write-ColorText "  [OK] Server stopped" Green
    }
    if ($script:extensionProcess -and -not $script:extensionProcess.HasExited) {
        # /T so the WXT child tree goes with it.
        & taskkill /F /T /PID $script:extensionProcess.Id 2>$null | Out-Null
        Write-ColorText "  [OK] Extension dev server stopped" Green
    }
}

Clear-Host
Write-ColorText "" Cyan
Write-ColorText "  SIH Zero-Trust AI Web Agent  -  DEVELOPMENT" Cyan
Write-ColorText "  Smart India Hackathon 2025" DarkCyan
Write-ColorText "  Client redaction + server VLM + local UI vision (ONNX)" DarkCyan
Write-ColorText "" Cyan

try {
    # ── 1. Node ─────────────────────────────────────────────────────────────
    Write-ColorText "  [1/4] Checking Node.js..." Yellow
    $nodeVersion = (& node --version 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Write-ColorText "  [FAIL] Node.js not found. Install Node 20+ from https://nodejs.org/" Red
        exit 1
    }
    Write-ColorText "  [OK] Node.js $nodeVersion" Green

    # ── 2. Server ───────────────────────────────────────────────────────────
    Write-ColorText "`n  [2/4] Starting the server (watch mode)..." Yellow

    $serverPath = Resolve-Path $ServerDir -ErrorAction SilentlyContinue
    if (-not $serverPath) { Write-ColorText "  [FAIL] No server/ directory found." Red; exit 1 }
    $serverPath = $serverPath.Path

    $envFile = Join-Path $serverPath ".env"
    if (-not (Test-Path $envFile)) {
        # The old script skipped this entirely, then reported success while
        # the server had already exited on a missing SECRET_PASSWORD.
        Write-ColorText "  [FAIL] No server/.env. Copy server/.env.example and fill it in." Red
        Write-ColorText "         The server exits on boot without SECRET_PASSWORD and a provider." DarkGray
        exit 1
    }
    $envContent = Get-Content $envFile -Raw
    $hasProvider = ($envContent -match '(?m)^\s*GEMINI_API_KEY\s*=\s*\S+') -or
                   (($envContent -match '(?m)^\s*ROUTER_URL\s*=\s*\S+') -and
                    ($envContent -match '(?m)^\s*ROUTER_API_KEY\s*=\s*\S+'))
    if ($envContent -notmatch '(?m)^\s*SECRET_PASSWORD\s*=\s*\S+') {
        Write-ColorText "  [FAIL] server/.env has no SECRET_PASSWORD." Red
        exit 1
    }
    if (-not $hasProvider) {
        Write-ColorText "  [FAIL] server/.env has no provider (GEMINI_API_KEY, or ROUTER_URL + ROUTER_API_KEY)." Red
        exit 1
    }
    Write-ColorText "  [OK] server/.env looks usable" Green

    Push-Location $serverPath
    try {
        if (-not (Test-Path "node_modules")) {
            Write-ColorText "  Installing server dependencies (npm ci)..." Cyan
            & npm ci
            if ($LASTEXITCODE -ne 0) { Write-ColorText "  [FAIL] npm ci failed" Red; exit 1 }
        }
        $script:serverProcess = Start-Process -FilePath "npm.cmd" `
            -ArgumentList "run", "dev" -PassThru -NoNewWindow `
            -RedirectStandardOutput "server_out.log" -RedirectStandardError "server_err.log"
    } finally { Pop-Location }

    # Wait for the port. Two seconds was the old behaviour and it proved
    # nothing: the server exits on a bad environment, and a dead process looks
    # exactly like a slow one after a fixed sleep.
    Write-ColorText "  Waiting for port $ServerPort..." Cyan
    $up = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($serverProcess.HasExited) {
            Write-ColorText "  [FAIL] The server exited during startup. server/server_err.log:" Red
            Get-Content (Join-Path $serverPath "server_err.log") -Tail 15 -ErrorAction SilentlyContinue |
                ForEach-Object { Write-ColorText "         $_" DarkGray }
            exit 1
        }
        if (Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue) {
            $up = $true; break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $up) {
        Write-ColorText "  [FAIL] Server did not listen on $ServerPort within 30s." Red
        exit 1
    }
    Write-ColorText "  [OK] Server listening on 127.0.0.1:$ServerPort" Green

    # ── 3. Extension ────────────────────────────────────────────────────────
    Write-ColorText "`n  [3/4] Starting the WXT dev server..." Yellow

    $extPath = Resolve-Path $ExtensionDir -ErrorAction SilentlyContinue
    if (-not $extPath) { Write-ColorText "  [FAIL] No extension/ directory found." Red; exit 1 }
    $extPath = $extPath.Path

    Push-Location $extPath
    try {
        if (-not (Test-Path "node_modules")) {
            Write-ColorText "  Installing extension dependencies (npm ci)..." Cyan
            & npm ci
            if ($LASTEXITCODE -ne 0) { Write-ColorText "  [FAIL] npm ci failed" Red; exit 1 }
        }
        $script:extensionProcess = Start-Process -FilePath "npm.cmd" `
            -ArgumentList "run", "dev" -PassThru
    } finally { Pop-Location }
    Write-ColorText "  [OK] WXT dev server starting" Green

    # ── 4. Banner ───────────────────────────────────────────────────────────
    Write-ColorText "" Green
    Write-ColorText "  +--------------------------------------------------------+" Green
    Write-ColorText "  |  DEV STACK IS LIVE                                      |" Green
    Write-ColorText "  +--------------------------------------------------------+" Green
    Write-ColorText ""
    Write-ColorText "  Server:     http://127.0.0.1:$ServerPort  (loopback only)" Cyan
    Write-ColorText "  Extension:  $extPath\.output\chrome-mv3-dev" Cyan
    Write-ColorText ""
    Write-ColorText "  Load it:" White
    Write-ColorText "    1. chrome://extensions/  ->  Developer mode ON" White
    Write-ColorText "    2. 'Load unpacked'  ->  the .output\chrome-mv3-dev folder above" White
    Write-ColorText ""
    Write-ColorText "  PAIRING: the server prints a one-time pairing code on boot." Yellow
    Write-ColorText "  It is in server\server_out.log, or read it with:" DarkGray
    Write-ColorText "    Select-String -Path server\server_out.log -Pattern 'Pairing code'" DarkGray
    Write-ColorText "  Enter it in the extension's side panel. Single use." DarkGray
    Write-ColorText ""
    Write-ColorText "  Ctrl+C stops both. (The old script's handler never fired;" Yellow
    Write-ColorText "  this one is a real try/finally.)" DarkYellow
    Write-ColorText ""

    # ── 5. Wait ─────────────────────────────────────────────────────────────
    while ($true) {
        Start-Sleep -Seconds 1
        if ($serverProcess.HasExited) {
            Write-ColorText "  [WARN] The server exited. server/server_err.log:" Yellow
            Get-Content (Join-Path $serverPath "server_err.log") -Tail 15 -ErrorAction SilentlyContinue |
                ForEach-Object { Write-ColorText "         $_" DarkGray }
            break
        }
        if ($extensionProcess.HasExited) {
            Write-ColorText "  [WARN] The WXT dev server exited." Yellow
            break
        }
    }
}
finally {
    # try/finally on Ctrl+C is the part PowerShell actually guarantees. The old
    # script used Register-EngineEvent on PowerShell.Exiting, which a console
    # Ctrl+C never raises, so its cleanup was dead code and both processes
    # survived.
    Write-ColorText ""
    Stop-AllProcesses
}

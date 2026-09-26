#Requires -Version 5.1
<#
.SYNOPSIS
    SIH Zero-Trust AI Web Agent - PRODUCTION launcher.

.DESCRIPTION
    Builds the extension, verifies the artifacts, starts the production server
    and prints the pairing code the extension needs.

    Never runs a dev server. For development use extension/171s.ps1 instead.

.NOTES
    Updated for the security work. Three things it previously got wrong, all of
    which made it fail or mislead:

    1. It required ROUTER_URL + ROUTER_API_KEY. The server accepts
       GEMINI_API_KEY *or* the router pair, so a Gemini-only setup was
       wrongly rejected.

    2. It never mentioned pairing. Auth is a signed bearer token since the
       token work landed; the extension must exchange a one-time pairing code
       for a token, and this script is where the operator learns that code.

    3. Its "ghost killer" force-killed ANY process on port 3000, including
       processes that had nothing to do with this project. It now checks what
       it is about to kill.

.EXAMPLE
    .\s.ps1
.EXAMPLE
    .\s.ps1 -Port 4000
#>

param(
    [int]$Port = 3000,
    [switch]$SkipBuild,
    [switch]$SkipGates
)

$ErrorActionPreference = "Stop"
$repoRoot   = $PSScriptRoot
$serverDir  = Join-Path $repoRoot "server"
$extDir     = Join-Path $repoRoot "extension"
$extOut     = Join-Path $extDir ".output\chrome-mv3"
$serverLog  = Join-Path $repoRoot "scratch\server-prod.log"
$serverProc = $null

function Write-Step { param([string]$m) Write-Host "`n$m" -ForegroundColor Cyan }
function Write-Ok   { param([string]$m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn { param([string]$m) Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Bad  { param([string]$m) Write-Host "  [FAIL] $m" -ForegroundColor Red }

function Stop-Children {
    if ($serverProc -and -not $serverProc.HasExited) {
        Write-Warn "Stopping server (PID $($serverProc.Id))..."
        # /T so the whole tree goes, not just the npm wrapper.
        & taskkill /F /T /PID $serverProc.Id 2>$null | Out-Null
    }
}

try {
    # ── PHASE A: free the port, but only from OUR OWN processes ──────────────
    Write-Step "PHASE A  Port $Port"

    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
        foreach ($conn in $listeners) {
            $ownerPid = $conn.OwningProcess
            $procName = ""
            $cmdLine  = ""
            try {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction Stop
                $procName = $p.Name
                $cmdLine  = $p.CommandLine
            } catch { continue }

            $isOurs = $cmdLine -match "dist[\\/]index\.js" -or $cmdLine -match "171-code"
            if ($isOurs) {
                Write-Warn "Port $Port held by a previous run (PID $ownerPid, $procName). Stopping it."
                & taskkill /F /T /PID $ownerPid 2>$null | Out-Null
            }
            else {
                # The old version force-killed whatever it found here. That
                # could take down an unrelated development server with no
                # warning and no way to tell what happened afterwards.
                Write-Bad "Port $Port is held by an unrelated process:"
                Write-Host  "        PID $ownerPid  $procName" -ForegroundColor DarkGray
                Write-Host  "        $cmdLine" -ForegroundColor DarkGray
                Write-Bad "Refusing to kill it. Free the port, or re-run with -Port <other>."
                exit 1
            }
        }
        Start-Sleep -Seconds 1
    }
    Write-Ok "Port $Port is free."

    # ── PHASE B: environment ────────────────────────────────────────────────
    Write-Step "PHASE B  Environment"

    $envPath = Join-Path $serverDir ".env"
    if (-not (Test-Path $envPath)) {
        Write-Bad "No server/.env found."
        Write-Host  "  Copy server/.env.example to server/.env and fill it in." -ForegroundColor DarkGray
        Write-Host  "  Never commit the filled copy." -ForegroundColor DarkGray
        exit 1
    }

    $envContent = Get-Content $envPath -Raw
    $missing = @()

    # Required to boot, unconditionally.
    if ($envContent -notmatch '(?m)^\s*SECRET_PASSWORD\s*=\s*\S+') { $missing += "SECRET_PASSWORD" }

    # A provider is required, but EITHER one satisfies it. The previous version
    # demanded the router pair, which rejected a perfectly valid Gemini-only
    # configuration before the server was ever started.
    $hasGemini = $envContent -match '(?m)^\s*GEMINI_API_KEY\s*=\s*\S+'
    $hasRouter = ($envContent -match '(?m)^\s*ROUTER_URL\s*=\s*\S+') -and
                 ($envContent -match '(?m)^\s*ROUTER_API_KEY\s*=\s*\S+')
    if (-not ($hasGemini -or $hasRouter)) {
        $missing += "GEMINI_API_KEY  (or ROUTER_URL + ROUTER_API_KEY)"
    }

    if ($missing.Count -gt 0) {
        Write-Bad "server/.env is missing or has empty values:"
        foreach ($m in $missing) { Write-Host "        - $m" -ForegroundColor Red }
        exit 1
    }
    Write-Ok "server/.env validated (SECRET_PASSWORD + provider)."

    # ── PHASE C: build and verify ───────────────────────────────────────────
    if (-not $SkipBuild) {
        Write-Step "PHASE C  Production build"

        Push-Location $extDir
        try {
            if (-not (Test-Path "node_modules")) {
                Write-Host "  Installing extension dependencies..." -ForegroundColor Yellow
                & npm ci
                if ($LASTEXITCODE -ne 0) { Write-Bad "npm ci failed in extension/."; exit 1 }
            }
            Write-Host "  Building extension (wxt build)..." -ForegroundColor Yellow
            & npm run build
            if ($LASTEXITCODE -ne 0) { Write-Bad "Extension build failed."; exit 1 }
        } finally { Pop-Location }
        Write-Ok "Extension built -> $extOut"
    }

    if (-not $SkipGates) {
        # The gates are cheap and they are the only thing standing between a
        # bad commit and a shipped artifact. The old script shipped whatever
        # came out of the build.
        Write-Step "PHASE D  Artifact gates"

        Push-Location $repoRoot
        try {
            & node "scripts\verify-repo-hygiene.mjs"
            if ($LASTEXITCODE -ne 0) { Write-Bad "Repo hygiene gate FAILED. Refusing to start."; exit 1 }
            & node "scripts\verify-bundle.mjs"
            if ($LASTEXITCODE -ne 0) { Write-Bad "Bundle gate FAILED. Refusing to start."; exit 1 }
        } finally { Pop-Location }
        Write-Ok "Gates passed."
    }

    # ── PHASE E: start the server ───────────────────────────────────────────
    Write-Step "PHASE E  Server"

    if (-not (Test-Path (Join-Path $serverDir "node_modules"))) {
        Push-Location $serverDir
        try {
            Write-Host "  Installing server dependencies..." -ForegroundColor Yellow
            & npm ci
            if ($LASTEXITCODE -ne 0) { Write-Bad "npm ci failed in server/."; exit 1 }
        } finally { Pop-Location }
    }

    New-Item -ItemType Directory -Force -Path (Split-Path $serverLog) | Out-Null
    if (Test-Path $serverLog) { Remove-Item $serverLog -Force }

    # `npm start` runs `prestart` (the real bundle build) then `node dist/index.js`.
    # It is no longer `npx tsx`, so nothing is transpiled on boot.
    $serverProc = Start-Process -FilePath "npm.cmd" -ArgumentList "run", "start" `
                    -WorkingDirectory $serverDir -PassThru -NoNewWindow `
                    -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err"

    # Poll the port instead of sleeping a fixed amount. A fixed sleep is either
    # flaky on a slow machine or pointlessly slow on a fast one, and it cannot
    # tell "slow" apart from "dead".
    Write-Host "  Waiting for the server to accept connections..." -ForegroundColor Yellow
    $up = $false
    for ($i = 0; $i -lt 120; $i++) {
        if ($serverProc.HasExited) {
            Write-Bad "The server exited during startup. Log:"
            Get-Content $serverLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
            exit 1
        }
        $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listening) { $up = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $up) {
        Write-Bad "The server did not start listening on port $Port within 60s."
        Get-Content $serverLog -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
        exit 1
    }
    Write-Ok "Server listening on 127.0.0.1:$Port (loopback only)."

    # ── PHASE F: surface the pairing code ───────────────────────────────────
    # Read it out of the boot log rather than making the operator scroll. The
    # server prints it once; if the operator pinned SECRETS_PAIRING_CODE in
    # their own .env, they already know it.
    Write-Step "PHASE F  Pair the extension"
    $pairing = $null
    for ($i = 0; $i -lt 20 -and -not $pairing; $i++) {
        $pairing = (Select-String -Path $serverLog -Pattern "Pairing code:\s+(\S+)" -ErrorAction SilentlyContinue |
                    Select-Object -First 1)
        if (-not $pairing) { Start-Sleep -Milliseconds 250 }
    }

    Write-Host ""
    Write-Host "  +--------------------------------------------------------+" -ForegroundColor Green
    Write-Host "  |  STACK IS LIVE                                          |" -ForegroundColor Green
    Write-Host "  +--------------------------------------------------------+" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Server:        http://127.0.0.1:$Port   (loopback only)" -ForegroundColor Cyan

    if ($pairing) {
        $code = $pairing.Matches[0].Groups[1].Value
        Write-Host ""
        Write-Host "  +--------------------------------------------------------+" -ForegroundColor Yellow
        Write-Host "  |  PAIRING CODE  (needed once, to pair the extension)     |" -ForegroundColor Yellow
        Write-Host "  |                                                        |" -ForegroundColor Yellow
        Write-Host "  |    $code" -ForegroundColor White
        Write-Host "  |                                                        |" -ForegroundColor Yellow
        Write-Host "  +--------------------------------------------------------+" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  Enter this in the extension's side panel when it asks." -ForegroundColor White
        Write-Host "  It is single-use. If you lose it, restart the server." -ForegroundColor DarkGray
    }
    elseif ($envContent -match '(?m)^\s*SECRETS_PAIRING_CODE\s*=\s*\S+') {
        Write-Host "  Pairing code:  pinned in your own server/.env." -ForegroundColor White
    }
    else {
        Write-Warn "Could not read the pairing code from the log. Read it with:"
        Write-Host "        Select-String -Path '$serverLog' -Pattern 'Pairing code'" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "  Load the extension:" -ForegroundColor White
    Write-Host "    1. Open chrome://extensions/" -ForegroundColor White
    Write-Host "    2. Enable Developer mode (top right)" -ForegroundColor White
    Write-Host "    3. 'Load unpacked' -> select:" -ForegroundColor White
    Write-Host "       $extOut" -ForegroundColor White
    Write-Host ""
    Write-Host "  Logs: $serverLog" -ForegroundColor DarkGray
    Write-Host "  Ctrl+C to stop." -ForegroundColor DarkGray
    Write-Host ""

    # ── PHASE G: stay up, clean up on the way out ───────────────────────────
    while (-not $serverProc.HasExited) { Start-Sleep -Seconds 1 }
    if ($serverProc.HasExited) {
        Write-Warn "The server process exited. Last log lines:"
        Get-Content $serverLog -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
    }
}
finally {
    Write-Host ""
    Stop-Children
    Write-Ok "Stopped."
}

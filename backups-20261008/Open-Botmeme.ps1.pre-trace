param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$botRoot = 'C:\Botmeme'
$botUrl = 'http://127.0.0.1:7883/meme-trader/'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$launchMutex = New-Object System.Threading.Mutex($false, 'Local\BotmemeDesktopLauncher7883')
$lockHeld = $false
function Test-BotmemeReady {
    try {
        $page = Invoke-WebRequest -Uri $botUrl -UseBasicParsing -TimeoutSec 2
        return ($page.StatusCode -eq 200 -and $page.Content.Contains('Meme Trader'))
    } catch { return $false }
}
try {
    try { $lockHeld = $launchMutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $lockHeld = $true }
    if (-not $lockHeld) { throw 'Botmeme is still starting. Please try again shortly.' }
    if (-not (Test-BotmemeReady)) {
        if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js was not found.' }
        $listener = Get-NetTCPConnection -LocalPort 7883 -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw 'Port 7883 is occupied or Botmeme is not responding. No second server was started.' }
        $journalLock = Join-Path $botRoot 'data\runtime.jsonl.lock'
        if (Test-Path -LiteralPath $journalLock) {
            $ownerText = [IO.File]::ReadAllText($journalLock).Trim()
            if ($ownerText -notmatch '^[1-9][0-9]*$') { throw 'Runtime lock is unreadable; manual inspection is needed.' }
            $ownerProcess = Get-Process -Id ([int]$ownerText) -ErrorAction SilentlyContinue
            if ($ownerProcess) { throw "Runtime is owned by process $ownerText. No second server was started." }
            # Only recover an orphaned PID lock; the runtime validates the journal itself.
            if ([IO.File]::ReadAllText($journalLock).Trim() -ne $ownerText) { throw 'Runtime lock changed. Try again.' }
            Remove-Item -LiteralPath $journalLock
        }
        $env:BOTMEME_PORT = '7883'
        Remove-Item Env:BOTMEME_JOURNAL -ErrorAction SilentlyContinue
        # RPC endpoints (Helius ...) from rpc.env — KEY=VALUE per line, kept out of git.
        $rpcEnv = Join-Path $botRoot 'rpc.env'
        if (Test-Path -LiteralPath $rpcEnv) {
            Get-Content -LiteralPath $rpcEnv | ForEach-Object {
                $line = $_.Trim()
                if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
                    $parts = $line.Split('=', 2)
                    Set-Item -Path ("Env:" + $parts[0].Trim()) -Value $parts[1].Trim()
                }
            }
        }
        $logRoot = Join-Path $botRoot 'data'
        $null = New-Item -ItemType Directory -Path $logRoot -Force
        $runStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $process = Start-Process -FilePath $nodePath -ArgumentList '"C:\Botmeme\scripts\serve-meme-trader.cjs"' -WorkingDirectory $botRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "launcher-$runStamp.stdout.log") -RedirectStandardError (Join-Path $logRoot "launcher-$runStamp.stderr.log")
        $ready = $false
        for ($attempt=0; $attempt -lt 40; $attempt++) {
            if (Test-BotmemeReady) { $ready=$true; break }
            if ($process.HasExited) { throw "Botmeme could not start. See data\launcher-$runStamp.stderr.log." }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'Botmeme did not become ready. Check the launcher logs in C:\Botmeme\data.' }
    }
    if (-not $NoBrowser) { Start-Process $botUrl }
    Write-Output 'BOTMEME_READY http://127.0.0.1:7883/meme-trader/'
} catch {
    if (-not $NoBrowser) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Botmeme', 'OK', 'Error') | Out-Null
    }
    Write-Error $_
    exit 1
} finally {
    if ($lockHeld) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}

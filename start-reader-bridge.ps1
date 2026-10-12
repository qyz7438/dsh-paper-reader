# Start or refresh the authenticated reader bridge for the active DSH renderer.
# It uses only DSH Desktop-owned loopback listeners and a bounded retry; neither
# CDP nor a user-provided renderer-origin environment variable is required.
param(
    [string]$Root = 'E:\DSH1\paper-reader',
    [string]$NodePath = 'E:\nodejs\node.exe',
    [int]$Port = 58812,
    [string]$DshExecutable = 'E:\DSH1\DSH Desktop\DSH Desktop.exe',
    [int]$DiscoveryAttempts = 30,
    [int]$RetryDelayMs = 500
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    param([string]$Path)
    return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Test-ExactCommandToken {
    param([string]$CommandLine, [string]$Token)
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Token)) { return $false }
    $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($Token) + '(?=$|[\s"])'
    return [regex]::IsMatch($CommandLine, $pattern)
}

function Test-DshRendererIdentity {
    param(
        [string]$OwnerPath,
        [string]$ParentPath,
        [string]$CommandLine,
        [int]$ListenerPort,
        [string]$DesktopExecutable
    )
    $desktop = Get-NormalizedPath $DesktopExecutable
    $desktopRoot = Split-Path -Parent $desktop
    $bundledNode = Join-Path $desktopRoot 'resources\app.asar.unpacked\node_modules\node\bin\node.exe'
    $harnessEntry = Join-Path $desktopRoot 'resources\harness-node-entry.mjs'
    $dshEntry = Join-Path $desktopRoot 'resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js'
    if ($OwnerPath -ine $bundledNode -or $ParentPath -ine $desktop) { return $false }
    if (-not ((Test-ExactCommandToken $CommandLine $harnessEntry) -and
        (Test-ExactCommandToken $CommandLine $dshEntry) -and
        (Test-ExactCommandToken $CommandLine 'web'))) { return $false }
    $hostPattern = '(?i)--host\s+(?:"127\.0\.0\.1"|127\.0\.0\.1)(?=$|[\s"])'
    $portPattern = '(?i)--port\s+(?:"' + [regex]::Escape([string]$ListenerPort) + '"|' + [regex]::Escape([string]$ListenerPort) + ')(?=$|[\s"])'
    return [regex]::IsMatch($CommandLine, $hostPattern) -and [regex]::IsMatch($CommandLine, $portPattern)
}

function Test-DshRendererResponse {
    param([int]$StatusCode, [string]$Body)
    if ($StatusCode -eq 200) { return $Body -match '__ModuleLoader__' }
    # DSH's authenticated renderer returns this exact public liveness marker
    # to a loopback probe that lacks its browser session cookie. It is accepted
    # only after Test-DshRendererIdentity has accepted the owning process.
    return $StatusCode -eq 401 -and $Body.Trim() -ceq 'dsh web authentication required; reopen the URL printed by dsh web.'
}

function Get-LimitedHttpErrorBody {
    param($Response)
    $stream = $null
    $reader = $null
    try {
        if ($null -ne $Response -and $null -ne $Response.PSObject.Properties['Content'] -and $null -ne $Response.Content) {
            $stream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        } elseif ($null -ne $Response -and $Response -is [System.Net.WebResponse]) {
            $stream = $Response.GetResponseStream()
        }
        if ($null -eq $stream) { return '' }
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true, 256, $true)
        $buffer = New-Object char[] 256
        $count = $reader.Read($buffer, 0, $buffer.Length)
        if ($count -le 0) { return '' }
        return [string]::new($buffer, 0, $count)
    } catch { return '' }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-DshDesktopOrigin {
    param([string]$ExecutablePath)
    # CDP is intentionally not used. Current DSH serves its web renderer from
    # a bundled Node child whose direct parent is the exact desktop executable.
    # Every command-line component below is checked before its HTTP marker is
    # queried; arbitrary Node loopback listeners are never treated as DSH.
    $expected = Get-NormalizedPath $ExecutablePath
    $candidatePorts = @()
    foreach ($connection in Get-NetTCPConnection -State Listen -ErrorAction Stop) {
        if ($connection.LocalAddress -notin @('127.0.0.1', '::1')) { continue }
        try {
            $owner = Get-Process -Id $connection.OwningProcess -ErrorAction Stop
            $record = Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.Id)" -ErrorAction Stop
            $parent = Get-Process -Id $record.ParentProcessId -ErrorAction Stop
            if (-not (Test-DshRendererIdentity -OwnerPath $owner.Path -ParentPath $parent.Path `
                -CommandLine ([string]$record.CommandLine) -ListenerPort $connection.LocalPort -DesktopExecutable $expected)) { continue }
            $candidatePorts += $connection.LocalPort
        } catch { continue }
    }
    foreach ($candidatePort in ($candidatePorts | Sort-Object -Unique)) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$candidatePort/" -UseBasicParsing -TimeoutSec 2
            if (Test-DshRendererResponse -StatusCode ([int]$response.StatusCode) -Body ([string]$response.Content)) {
                return "http://127.0.0.1:$candidatePort"
            }
        } catch {
            $failure = $_.Exception.Response
            if ($null -eq $failure) { continue }
            try { $status = [int]$failure.StatusCode } catch { continue }
            $body = Get-LimitedHttpErrorBody $failure
            if (Test-DshRendererResponse -StatusCode $status -Body $body) {
                return "http://127.0.0.1:$candidatePort"
            }
        }
    }
    return $null
}

function Wait-DshDesktopOrigin {
    param([string]$ExecutablePath, [int]$Attempts, [int]$DelayMs)
    if ($Attempts -lt 1) { throw 'DiscoveryAttempts must be at least one.' }
    for ($attempt = 1; $attempt -le $Attempts; $attempt += 1) {
        $origin = Get-DshDesktopOrigin $ExecutablePath
        if (-not [string]::IsNullOrWhiteSpace($origin)) { return $origin }
        if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMs }
    }
    throw 'Cannot discover an exact DSH renderer origin from the DSH Desktop-owned loopback listener; reader bridge was not started.'
}

function Get-BridgeOriginFromCommandLine {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $match = [regex]::Match($CommandLine, '(?i)--dsh-reader-desktop-origin\s+(?:"(?<quoted>[^"]+)"|(?<bare>\S+))')
    if (-not $match.Success) { return $null }
    if ($match.Groups['quoted'].Success) { return $match.Groups['quoted'].Value }
    return $match.Groups['bare'].Value
}

function Get-BridgeOwner {
    param([int]$TargetPort, [string]$ExpectedNodePath, [string]$BridgeScript)
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $TargetPort -and $_.LocalAddress -in @('127.0.0.1', '::1') })
    if ($listeners.Count -eq 0) { return $null }
    if ($listeners.Count -ne 1) { return [pscustomobject]@{ Kind = 'unknown'; Reason = 'multiple_loopback_listeners' } }
    try {
        $process = Get-Process -Id $listeners[0].OwningProcess -ErrorAction Stop
        $nodePath = Get-NormalizedPath $ExpectedNodePath
        if ($process.Path -ine $nodePath) {
            return [pscustomobject]@{ Kind = 'unknown'; ProcessId = $process.Id; Reason = 'unexpected_executable' }
        }
        $record = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction Stop
        $commandLine = [string]$record.CommandLine
        $scriptPattern = '(?i)(?:^|[\s"])' + [regex]::Escape((Get-NormalizedPath $BridgeScript)) + '(?=$|[\s"])'
        if (-not [regex]::IsMatch($commandLine, $scriptPattern)) {
            return [pscustomobject]@{ Kind = 'unknown'; ProcessId = $process.Id; Reason = 'unexpected_node_command' }
        }
        return [pscustomobject]@{
            Kind = 'standalone'
            ProcessId = $process.Id
            Origin = Get-BridgeOriginFromCommandLine $commandLine
        }
    } catch {
        return [pscustomobject]@{ Kind = 'unknown'; Reason = 'owner_uninspectable' }
    }
}

function Get-BridgeAction {
    param($Owner, [string]$ExpectedOrigin)
    if ($null -eq $Owner) { return 'start' }
    if ($Owner.Kind -ne 'standalone') { return 'reject' }
    if ([string]$Owner.Origin -ceq $ExpectedOrigin) { return 'reuse' }
    return 'restart'
}

function Stop-ExactStandaloneBridge {
    param([int]$ProcessId, [int]$TargetPort)
    Stop-Process -Id $ProcessId -ErrorAction Stop
    for ($attempt = 1; $attempt -le 20; $attempt += 1) {
        $listener = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -eq $TargetPort -and $_.LocalAddress -in @('127.0.0.1', '::1') })
        if ($listener.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'The verified standalone reader bridge did not release its loopback port.'
}

function Start-NewReaderBridge {
    param([string]$ReaderRoot, [string]$NodeExecutable, [string]$DesktopOrigin)
    $script = Join-Path $ReaderRoot 'reader-bridge-standalone.mjs'
    if (-not (Test-Path -LiteralPath $NodeExecutable) -or -not (Test-Path -LiteralPath $script)) {
        throw 'Reader bridge executable or source is missing.'
    }
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $NodeExecutable
    # The argument is deliberately non-secret and lets the next helper prove
    # whether the existing bridge belongs to the currently discovered renderer.
    $psi.Arguments = ('"{0}" --dsh-reader-desktop-origin "{1}"' -f $script, $DesktopOrigin)
    $psi.WorkingDirectory = $ReaderRoot
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['DSH_READER_DESKTOP_ORIGIN'] = $DesktopOrigin
    [void][System.Diagnostics.Process]::Start($psi)
}

function Invoke-ReaderBridgeStartup {
    param([string]$ReaderRoot, [string]$NodeExecutable, [int]$TargetPort, [string]$DesktopExecutable, [int]$Attempts, [int]$DelayMs)
    $origin = Wait-DshDesktopOrigin -ExecutablePath $DesktopExecutable -Attempts $Attempts -DelayMs $DelayMs
    $bridgeScript = Join-Path $ReaderRoot 'reader-bridge-standalone.mjs'
    $owner = Get-BridgeOwner -TargetPort $TargetPort -ExpectedNodePath $NodeExecutable -BridgeScript $bridgeScript
    switch (Get-BridgeAction -Owner $owner -ExpectedOrigin $origin) {
        'reuse' { return [pscustomobject]@{ Status = 'reused'; Origin = $origin } }
        'restart' { Stop-ExactStandaloneBridge -ProcessId $owner.ProcessId -TargetPort $TargetPort }
        'reject' { throw 'Reader bridge port is occupied by an unverified process; it was not stopped or replaced.' }
    }
    Start-NewReaderBridge -ReaderRoot $ReaderRoot -NodeExecutable $NodeExecutable -DesktopOrigin $origin
    return [pscustomobject]@{ Status = 'started'; Origin = $origin }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-ReaderBridgeStartup -ReaderRoot $Root -NodeExecutable $NodePath -TargetPort $Port `
        -DesktopExecutable $DshExecutable -Attempts $DiscoveryAttempts -DelayMs $RetryDelayMs | Out-Null
}

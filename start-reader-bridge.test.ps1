# Isolated decision tests for the startup helper. Dot-sourcing must not inspect
# listeners or spawn a process; only pure command-line/action logic is covered.
. 'E:\DSH1\paper-reader\start-reader-bridge.ps1'

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL $Message" }
    Write-Output "PASS $Message"
}

Assert-True ((Get-BridgeOriginFromCommandLine '"E:\nodejs\node.exe" "E:\DSH1\paper-reader\reader-bridge-standalone.mjs" --dsh-reader-desktop-origin "http://127.0.0.1:43129"') -eq 'http://127.0.0.1:43129') 'parses non-secret exact origin from the standalone command line'
$desktop = 'E:\DSH1\DSH Desktop\DSH Desktop.exe'
$desktopRoot = Split-Path -Parent $desktop
$bundledNode = Join-Path $desktopRoot 'resources\app.asar.unpacked\node_modules\node\bin\node.exe'
$harnessEntry = Join-Path $desktopRoot 'resources\harness-node-entry.mjs'
$dshEntry = Join-Path $desktopRoot 'resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js'
$rendererCommand = ('"{0}" --expose-internals "{1}" "{2}" web --host 127.0.0.1 --port 43129' -f $bundledNode, $harnessEntry, $dshEntry)
Assert-True (-not (Test-DshRendererIdentity -OwnerPath $desktop -ParentPath 'E:\other\parent.exe' -CommandLine 'unrelated --host 0.0.0.0 --port 9' -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects a direct Desktop owner without the verified bundled renderer contract'
Assert-True (Test-DshRendererIdentity -OwnerPath $bundledNode -ParentPath $desktop -CommandLine $rendererCommand -ListenerPort 43129 -DesktopExecutable $desktop) 'accepts only the verified bundled DSH web renderer child'
Assert-True (-not (Test-DshRendererIdentity -OwnerPath $bundledNode -ParentPath $desktop -CommandLine ($rendererCommand -replace 'web', 'worker') -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects a bundled node with the wrong web entry'
Assert-True (-not (Test-DshRendererIdentity -OwnerPath $bundledNode -ParentPath $desktop -CommandLine ($rendererCommand -replace [regex]::Escape($dshEntry), 'E:\evil\bin.js') -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects a bundled node with the wrong DSH entry file'
Assert-True (-not (Test-DshRendererIdentity -OwnerPath 'E:\other\node.exe' -ParentPath $desktop -CommandLine $rendererCommand -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects an unknown node executable'
Assert-True (-not (Test-DshRendererIdentity -OwnerPath $bundledNode -ParentPath 'E:\other\parent.exe' -CommandLine $rendererCommand -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects a bundled node with the wrong parent chain'
Assert-True (-not (Test-DshRendererIdentity -OwnerPath $bundledNode -ParentPath $desktop -CommandLine ($rendererCommand -replace '--port 43129', '--port 43130') -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects a renderer command with a mismatched listener port'
Assert-True (-not (Test-DshRendererIdentity -OwnerPath $bundledNode -ParentPath $desktop -CommandLine ($rendererCommand -replace '--host 127.0.0.1', '--host 0.0.0.0') -ListenerPort 43129 -DesktopExecutable $desktop)) 'rejects a renderer command with a non-loopback host'
Assert-True (Test-DshRendererResponse -StatusCode 401 -Body 'dsh web authentication required; reopen the URL printed by dsh web.') 'accepts the exact authenticated DSH 401 liveness marker'
Assert-True (-not (Test-DshRendererResponse -StatusCode 401 -Body 'unauthorized')) 'rejects a generic 401 response'
Assert-True (-not (Test-DshRendererResponse -StatusCode 200 -Body '<html>unrelated local service</html>')) 'rejects a 200 response without the DSH renderer marker'
Assert-True ((Get-BridgeAction -Owner $null -ExpectedOrigin 'http://127.0.0.1:43129') -eq 'start') 'starts only when no bridge listener exists'
Assert-True ((Get-BridgeAction -Owner ([pscustomobject]@{ Kind = 'standalone'; Origin = 'http://127.0.0.1:43129' }) -ExpectedOrigin 'http://127.0.0.1:43129') -eq 'reuse') 'reuses an exact standalone bridge only for the current origin'
Assert-True ((Get-BridgeAction -Owner ([pscustomobject]@{ Kind = 'standalone'; Origin = 'http://127.0.0.1:42000' }) -ExpectedOrigin 'http://127.0.0.1:43129') -eq 'restart') 'refreshes a verified standalone bridge when the renderer origin changes'
Assert-True ((Get-BridgeAction -Owner ([pscustomobject]@{ Kind = 'unknown'; Origin = $null }) -ExpectedOrigin 'http://127.0.0.1:43129') -eq 'reject') 'refuses to replace an unknown port owner'

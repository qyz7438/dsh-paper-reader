# Start the authenticated bridge for the currently running DSH Desktop renderer.
# The reader is embedded in DSH; this launcher intentionally does not open a
# standalone bridge URL, because root bootstrap requires the verified iframe origin.
$root = 'E:\DSH1\paper-reader'
& (Join-Path $root 'start-reader-bridge.ps1') -Root $root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

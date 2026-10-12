# Register the guarded bridge launcher at logon. It discovers the DSH renderer
# origin each time and fails closed when desktop CDP is unavailable.
$root = 'E:\DSH1\paper-reader'
$ws = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath('Startup')
$sc = $ws.CreateShortcut((Join-Path $startup 'dsh-reader-bridge.lnk'))
$sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$root\start-reader-bridge.ps1`""
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7
$sc.Description = 'DSH reader bridge (authenticated loopback)'
$sc.Save()
Write-Output "startup shortcut: $(Join-Path $startup 'dsh-reader-bridge.lnk')"

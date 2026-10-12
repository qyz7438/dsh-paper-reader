
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$sc = $ws.CreateShortcut((Join-Path $desktop '论文阅读器.lnk'))
$sc.TargetPath = 'E:\DSH1\DSH Desktop\DSH Desktop.exe'
$sc.Arguments = ''
$sc.WorkingDirectory = 'E:\DSH1\DSH Desktop'
$sc.IconLocation = 'E:\DSH1\DSH Desktop\DSH Desktop.exe,0'
$sc.Description = '打开 DSH 论文阅读器（论文列表 | 中英对照 | AI 会话）'
$sc.Save()
Write-Output 'shortcut updated'

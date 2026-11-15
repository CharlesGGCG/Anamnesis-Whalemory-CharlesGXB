# 启动 OBS（WMI 方式，避开 DSH 进程树）
#
# 为什么：从 DSH 的 shell 里 Start-Process 出来的 obs64 属于 DSH 的 job 对象，
# DSH 一重启整个树被回收，OBS 跟着被杀。用 WMI 创建进程，父进程是 WmiPrvSE，
# 不在 DSH 的 job 里，就不会被带走。
#
#   powershell -NoProfile -File scripts/start-obs.ps1
$exe = 'D:\SteamLibrary\steamapps\common\OBS Studio\bin\64bit\obs64.exe'
if (-not (Test-Path $exe)) { Write-Error "找不到 OBS：$exe"; exit 2 }
$running = Get-Process obs64 -ErrorAction SilentlyContinue
if ($running) { Write-Output "OBS 已在运行（pid $($running.Id -join ',')）"; exit 0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = "`"$exe`""
  CurrentDirectory = (Split-Path $exe)
}
if ($r.ReturnValue -ne 0) { Write-Error "WMI 启动失败：$($r.ReturnValue)"; exit 1 }
Write-Output "已启动 OBS（pid $($r.ProcessId)）"

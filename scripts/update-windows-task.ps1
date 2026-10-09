param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
# Брокер одного подтверждения: останавливает задачу, ждёт разрешение родителя, запускает.
# Маркеры: stopped (задача остановлена), go (разрешение запустить), done (ok | timeout | error).
$go = Join-Path $Dir 'go'
$stopped = Join-Path $Dir 'stopped'
$done = Join-Path $Dir 'done'
try {
  Stop-ScheduledTask -TaskName 'OpenCode jobs' -ErrorAction Stop
} catch {
  Set-Content -Path $done -Value 'error' -Encoding ascii
  exit 2
}
Set-Content -Path $stopped -Value 'ok' -Encoding ascii
$deadline = (Get-Date).AddSeconds(300)
while (-not (Test-Path -LiteralPath $go) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path -LiteralPath $go)) {
  Set-Content -Path $done -Value 'timeout' -Encoding ascii
  exit 3
}
try {
  Start-ScheduledTask -TaskName 'OpenCode jobs' -ErrorAction Stop
} catch {
  Set-Content -Path $done -Value 'error' -Encoding ascii
  exit 4
}
Set-Content -Path $done -Value 'ok' -Encoding ascii
exit 0

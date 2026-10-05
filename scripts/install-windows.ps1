param([string]$Artifact = (Join-Path $PSScriptRoot '..\.runtime\package'))

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Для новой startup-задачи требуется повышенный PowerShell. Существующие службы не изменяются.'
}
$taskName = 'OpenCode jobs'
$target = Join-Path $env:USERPROFILE '.config\opencode\plugins\jobs'
$state = Join-Path $env:USERPROFILE '.local\share\opencode-jobs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (Test-Path $target) { throw "Каталог уже существует: $target. Обновление требует отдельной проверки активных заданий." }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "Задача уже существует: $taskName." }
if (-not (Test-Path (Join-Path $Artifact 'index.js'))) { throw 'Проверенный артефакт не найден; сначала npm run build.' }
$staging = Join-Path $state ('install-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $staging -Force -ErrorAction Stop | Out-Null
Copy-Item -Path (Join-Path $Artifact '*') -Destination $staging -Recurse -ErrorAction Stop
$sourceRoot = (Resolve-Path $Artifact).Path
Get-ChildItem $sourceRoot -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring($sourceRoot.Length + 1)
  if ((Get-FileHash $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash (Join-Path $staging $relative) -Algorithm SHA256).Hash) {
    throw "Несовпадение SHA-256: $relative"
  }
}
New-Item -ItemType Directory -Path (Split-Path $target) -Force -ErrorAction Stop | Out-Null
Move-Item -Path $staging -Destination $target -ErrorAction Stop
$action = New-ScheduledTaskAction -Execute $node -Argument ('"' + (Join-Path $target 'src\pump.js') + '"') -WorkingDirectory $target
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $identity.Name))
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Локальный планировщик OpenCode V2; без замены сервера и без повторов прерванных shell-команд.' -ErrorAction Stop | Out-Null
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ([int]$registered.Principal.LogonType -ne 2) { throw 'Проверка нового principal не прошла.' }
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  $statusPath = Join-Path $state 'pump-status.json'
  if (Test-Path $statusPath) {
    $health = Get-Content $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $fresh = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $health.time -lt 5000
    if ($fresh -and $health.ok -and (Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State -eq 'Running') {
      Write-Output "Проверено: $taskName работает; pump PID $($health.pid), сервер доступен; пароли не запрашивались."
      return
    }
  }
} while ((Get-Date) -lt $deadline)
throw 'Установка записана, но здоровье pump не подтверждено. Не считать установку успешной; проверить pump-status.json и Get-ScheduledTaskInfo.'

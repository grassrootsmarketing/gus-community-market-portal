# install-windows-task.ps1 — registers the DAILY deterministic storage backup in Windows Task Scheduler.
# Run once, by David, in a normal (non-admin) PowerShell window. It stores no password: the task runs as the
# logged-on user. Re-running replaces the task definition. Remove with:
#   Unregister-ScheduledTask -TaskName 'Demohub storage backup (daily)' -Confirm:$false
#
#   catch-up after a missed start ......... -StartWhenAvailable
#   needs the network ...................... -RunOnlyIfNetworkAvailable
#   never two runs at once ................. -MultipleInstances IgnoreNew  (the tool also holds its own lock file)
#   bounded ................................ 30-minute execution limit; the tool retries a failed run at most 3 times
$ErrorActionPreference = 'Stop'
$node = 'C:\Program Files\nodejs\node.exe'
$cli  = 'C:\Users\David\demohub-docs\tools\backup\cli.mjs'
if (-not (Test-Path $node)) { throw "node.exe not found at $node" }
if (-not (Test-Path $cli))  { throw "backup tool not found at $cli" }

$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" daily" -WorkingDirectory (Split-Path $cli)
$trigger   = New-ScheduledTaskTrigger -Daily -At '12:30'
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew `
               -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Demohub storage backup (daily)' -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Encrypted daily snapshot of Demohub production uploaded files (read-only on production). Result: Documents\Codex\prod-storage-backup-v2\last-run.json' -Force | Out-Null

# Verify what was actually installed instead of assuming it.
$t = Get-ScheduledTask -TaskName 'Demohub storage backup (daily)'
[pscustomobject]@{
  Task                = $t.TaskName
  State               = $t.State
  DailyAt             = $t.Triggers[0].StartBoundary
  CatchUpAfterMissed  = $t.Settings.StartWhenAvailable
  NeedsNetwork        = $t.Settings.RunOnlyIfNetworkAvailable
  Overlap             = $t.Settings.MultipleInstances
  TimeLimit           = $t.Settings.ExecutionTimeLimit
  RunsAs              = $t.Principal.UserId
} | Format-List

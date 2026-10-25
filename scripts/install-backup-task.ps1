# Optional Windows Task Scheduler registration. Requires Windows ScheduledTasks.
# Computer must be powered on and the user must already configure Wrangler and rclone.
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_.-]+$')][string]$R2Remote,
 [string]$TaskName='CloudDrive-Offsite-Backup',
 [string]$At='03:30'
)
$ErrorActionPreference='Stop'
if ($At -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') {throw 'At must be HH:mm in 24-hour format.'}
$script=Join-Path $PSScriptRoot 'backup-production.ps1'
if (-not (Test-Path $script)) {throw 'backup-production.ps1 not found.'}
if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {throw 'ScheduledTasks module is unavailable; run this on Windows.'}
$arg='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -R2Remote {1}' -f $script,$R2Remote
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger=New-ScheduledTaskTrigger -Daily -At $At
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Description 'CloudDrive D1+R2 local backup; machine must be on, Wrangler and rclone auth configured.' -Force | Out-Null
Write-Host ('Windows schedule saved: {0} at {1} (local Windows clock)' -f $TaskName,$At)
Write-Warning 'Backups include sensitive data. Protect local destination, configure disk encryption and check Task Scheduler history.'

@echo off
setlocal
cd /d "%~dp0.."
if not exist backups mkdir backups
set BACKUP_FILE=backups\clouddrive-backup-%RANDOM%-%RANDOM%.sql
echo WARNING: This exports REMOTE production D1; R2 file contents are NOT included.
set /p CONFIRM=Type BACKUP to export the remote database: 
if /I not "%CONFIRM%"=="BACKUP" exit /b 1
call npx wrangler d1 export clouddrive-db --remote --output="%BACKUP_FILE%"
if errorlevel 1 exit /b 1
echo Saved remote D1 SQL to %BACKUP_FILE%
exit /b 0

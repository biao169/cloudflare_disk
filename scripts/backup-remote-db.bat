@echo off
setlocal
cd /d "%~dp0.."
echo Remote Cloudflare D1 database export, not including R2 file contents.
set /p CONFIRM=Type BACKUP to export the remote database: 
if /I not "%CONFIRM%"=="BACKUP" exit /b 1
call npm run db:backup:remote
if errorlevel 1 exit /b 1
exit /b 0

@echo off
setlocal
cd /d "%~dp0.."
echo WARNING: This applies incremental migrations to your EXISTING remote D1.
echo CloudDrive RC5 resolves database_id automatically without changing wrangler.jsonc.
set /p CONFIRM=Type MIGRATE-REMOTE to continue: 
if /I not "%CONFIRM%"=="MIGRATE-REMOTE" exit /b 1
call npm run db:migrate:remote
if errorlevel 1 exit /b 1
exit /b 0

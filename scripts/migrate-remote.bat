@echo off
setlocal
cd /d "%~dp0.."
echo WARNING: This applies migrations to REMOTE D1.
echo Export remote D1 and verify the backups first.
findstr /c:"00000000-0000-0000-0000-000000000001" wrangler.jsonc >nul
if not errorlevel 1 (echo ERROR: Replace the example D1 database_id in wrangler.jsonc first.& exit /b 1)
set /p CONFIRM=Type MIGRATE-REMOTE to continue: 
if /I not "%CONFIRM%"=="MIGRATE-REMOTE" exit /b 1
call npx wrangler d1 migrations apply clouddrive-db --remote
if errorlevel 1 exit /b 1
exit /b 0

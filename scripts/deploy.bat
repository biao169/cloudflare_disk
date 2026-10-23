@echo off
setlocal
cd /d "%~dp0.."
echo *** PRODUCTION DEPLOYMENT: THIS AFFECTS YOUR CLOUDFLARE ACCOUNT ***
echo First BACK UP remote D1, apply REMOTE migrations, and finish Windows browser smoke tests.
call scripts\preflight.bat
if errorlevel 1 (echo Preflight failed, deploy cancelled.& exit /b 1)
findstr /c:"00000000-0000-0000-0000-000000000001" wrangler.jsonc >nul
if not errorlevel 1 (echo ERROR: Replace the example D1 database_id in wrangler.jsonc first.& exit /b 1)
set /p CONFIRM=Type DEPLOY-PRODUCTION to continue: 
if /I not "%CONFIRM%"=="DEPLOY-PRODUCTION" (echo Cancelled.& exit /b 1)
call npx wrangler deploy
if errorlevel 1 exit /b 1
echo Deployment command finished. Complete post-deployment acceptance tests.
exit /b 0

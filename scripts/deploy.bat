@echo off
setlocal
cd /d "%~dp0.."
echo *** CloudDrive PRODUCTION deployment (auto D1 migration + Worker publish) ***
call npm run build
if errorlevel 1 (echo Tests failed. Deployment cancelled.& exit /b 1)
set /p CONFIRM=Type DEPLOY-PRODUCTION to continue: 
if /I not "%CONFIRM%"=="DEPLOY-PRODUCTION" exit /b 1
call npm run deploy
if errorlevel 1 exit /b 1
echo Complete. Check https://your-worker.workers.dev/api/v1/health/ready
exit /b 0

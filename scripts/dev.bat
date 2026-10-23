@echo off
setlocal
cd /d "%~dp0.."
if not exist "node_modules\.bin\wrangler.cmd" (echo Wrangler is not installed. Run: npm install& pause& exit /b 1)
echo First time? Run scripts\migrate-local.bat before starting.
call npx wrangler dev --local
pause

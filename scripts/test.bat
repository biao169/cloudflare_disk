@echo off
setlocal
cd /d "%~dp0.."
call npm run check
if errorlevel 1 exit /b 1
call npm test
pause

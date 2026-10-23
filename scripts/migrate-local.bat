@echo off
setlocal
cd /d "%~dp0.."
if not exist "node_modules\.bin\wrangler.cmd" (echo Run npm install first& exit /b 1)
call npx wrangler d1 migrations apply clouddrive-db --local
if errorlevel 1 exit /b 1
echo Local migrations completed.

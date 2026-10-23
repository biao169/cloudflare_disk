@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (echo ERROR: Node.js is missing.& exit /b 1)
if not exist "node_modules\.bin\wrangler.cmd" (echo ERROR: Run npm install first.& exit /b 1)
echo [1/3] Static JS syntax...
call npm run check
if errorlevel 1 exit /b 1
echo [2/3] Unit tests...
call npm test
if errorlevel 1 exit /b 1
echo [3/3] SQLite and simulated R2 integration tests (Node 22+)...
call npm run test:integration
if errorlevel 1 exit /b 1
echo All automated checks passed. Wrangler browser tests still required.
exit /b 0

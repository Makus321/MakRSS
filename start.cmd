@echo off
rem Запуск RSS-читалки на порту 8787 (адрес: http://127.0.0.1:8787)
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found in PATH. Install Node.js 18+ and retry.
  pause
  exit /b 1
)
echo RSS reader: http://127.0.0.1:8787
echo Press Ctrl+C to stop.
node server.mjs %*
pause

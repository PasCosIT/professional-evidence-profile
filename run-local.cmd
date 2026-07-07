@echo off
setlocal
cd /d "%~dp0"
set "PORT=4173"
set "NODE_EXE=C:\Users\PasqualeCosimato\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

echo Professional Evidence Profile
echo.
echo Starting local server on http://localhost:%PORT%
echo Keep this window open while testing the app.
echo Press CTRL+C here to stop the server.
echo.

"%NODE_EXE%" server.js
pause

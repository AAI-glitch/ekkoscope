@echo off
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║         Ekkoscope — Launching Brave Browser          ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo  NOTE: If Brave is already open, close it first.
echo.

start "" "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\BraveSoftware\Brave-Browser\EkkoscopeProfile"

echo  ✅ Brave launched with remote debugging on port 9222
echo.
echo  1. Log into recu.me in the browser window
echo  2. Keep the browser open
echo  3. Use the Ekkoscope web app to download!
echo.
timeout /t 5

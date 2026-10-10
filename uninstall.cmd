@echo off
rem Removes the plugin from your dsh profile, deletes the node_modules link it created, and puts
rem back the two strings the installer renamed inside the application's app.asar.
rem Extra arguments pass through, e.g.  uninstall.cmd --dry-run
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on PATH. It is needed once, to write the profile and the app.asar edit.
  echo Install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)
node "tools\install.mjs" --remove %*
set CODE=%ERRORLEVEL%
echo.
echo Exit code: %CODE%
pause
exit /b %CODE%

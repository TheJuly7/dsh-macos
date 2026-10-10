@echo off
rem One-click install: double-click this file, or run it from a terminal.
rem It adds the plugin to your dsh profile, links it, and hides the platform's caption buttons.
rem Pass extra arguments through, e.g.  install.cmd --profile work --dry-run
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
node "tools\install.mjs" %*
set CODE=%ERRORLEVEL%
echo.
echo Exit code: %CODE%
pause
exit /b %CODE%

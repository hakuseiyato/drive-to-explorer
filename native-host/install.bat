@echo off
REM Wrapper that invokes install.ps1.
REM PowerShell handles manifest.json substitution and registry registration.

setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%install.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

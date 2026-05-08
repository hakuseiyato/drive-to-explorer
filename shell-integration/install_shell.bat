@echo off
REM Register Explorer right-click "Drive で開く" for folders (HKCU).
REM Wraps install_shell.ps1.

setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%install_shell.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

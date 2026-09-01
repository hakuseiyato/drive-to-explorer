@echo off
REM Drive to Explorer - 初回セットアップ (これをダブルクリックするだけ)
REM setup.ps1 を実行する。エラー時にもウィンドウを残すため最後に pause。

setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%setup.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

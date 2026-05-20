@echo off
REM Drive to Explorer - 自動更新ラッパー
REM update.ps1 を実行する。

setlocal
set "DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%update.ps1" %*
set "RC=%ERRORLEVEL%"
exit /b %RC%

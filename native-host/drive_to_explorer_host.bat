@echo off
REM Native Messaging Host wrapper.
REM Chrome / Brave / Edge invokes this via stdin/stdout - DO NOT print to stdout.
REM Strategy: prefer pre-built exe (PyInstaller), fall back to Python.

setlocal
set "DIR=%~dp0"

if exist "%DIR%drive_to_explorer_host.exe" (
    "%DIR%drive_to_explorer_host.exe"
    exit /b
)

where py >nul 2>&1
if %errorlevel%==0 (
    py -3 "%DIR%drive_to_explorer_host.py"
) else (
    python "%DIR%drive_to_explorer_host.py"
)

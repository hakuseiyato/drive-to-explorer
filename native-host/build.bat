@echo off
REM Build drive_to_explorer_host.exe via PyInstaller.
REM Requires Python 3 and `pip install pyinstaller`.

setlocal
set "DIR=%~dp0"
cd /d "%DIR%"

REM Detect Python launcher
set "PY=py -3"
where py >nul 2>&1
if errorlevel 1 (
    where python >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Python 3 not found. Install Python 3 first.
        pause
        exit /b 1
    )
    set "PY=python"
)

REM Verify PyInstaller is available
%PY% -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo [INFO] PyInstaller not installed. Installing...
    %PY% -m pip install --user pyinstaller
    if errorlevel 1 (
        echo [ERROR] Failed to install PyInstaller.
        pause
        exit /b 1
    )
)

echo [INFO] Building drive_to_explorer_host.exe ...
%PY% -m PyInstaller ^
    --onefile ^
    --noconsole ^
    --distpath "%DIR%" ^
    --workpath "%DIR%build" ^
    --specpath "%DIR%build" ^
    --name drive_to_explorer_host ^
    "%DIR%drive_to_explorer_host.py"

if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

REM Cleanup intermediate artifacts
if exist "%DIR%build" rmdir /s /q "%DIR%build"

if exist "%DIR%drive_to_explorer_host.exe" (
    echo.
    echo [OK] Built: %DIR%drive_to_explorer_host.exe
    echo Re-run install.bat to register the host.
) else (
    echo [ERROR] exe not found after build.
    exit /b 1
)

pause
exit /b 0

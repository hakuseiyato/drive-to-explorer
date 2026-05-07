@echo off
REM Register Native Messaging Host for Chrome / Edge / Brave / Vivaldi / Chromium (HKCU).
REM Edit native-host\manifest.json and replace REPLACE_WITH_EXTENSION_ID before running.

setlocal
set "HOST_NAME=com.yato.drive_to_explorer"
set "MANIFEST=%~dp0manifest.json"

if not exist "%MANIFEST%" (
    echo manifest.json not found: %MANIFEST%
    pause
    exit /b 1
)

echo Registering %HOST_NAME%
echo   manifest: %MANIFEST%

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 goto err

reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\Vivaldi\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
reg add "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /ve /t REG_SZ /d "%MANIFEST%" /f >nul

echo Done. Restart your browser to take effect.
pause
exit /b 0

:err
echo Failed to register.
pause
exit /b 1

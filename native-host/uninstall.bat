@echo off
setlocal
set "HOST_NAME=com.yato.drive_to_explorer"
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Vivaldi\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
reg delete "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>&1
echo Unregistered %HOST_NAME%.
pause

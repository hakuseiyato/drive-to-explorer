# Register Explorer right-click "Drive で開く" for folders (HKCU).
#
# Two registrations:
#   - Directory\shell           : right-click on a folder
#   - Directory\Background\shell: right-click on empty area inside a folder
#
# Both invoke open_in_drive.ps1 with the folder path.

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Ps1 = Join-Path $ScriptDir "open_in_drive.ps1"

if (-not (Test-Path $Ps1)) {
    Write-Host "[ERROR] open_in_drive.ps1 not found: $Ps1" -ForegroundColor Red
    exit 1
}

$VerbName = "DriveToExplorer"
$Label = "Drive で開く"
$IconHint = ""  # 必要なら ICO ファイルパスを設定

$PowerShellExe = "$Env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$CmdLine = '"' + $PowerShellExe + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Ps1 + '" -Path "%V"'

$Targets = @(
    "HKCU:\Software\Classes\Directory\shell\$VerbName",
    "HKCU:\Software\Classes\Directory\Background\shell\$VerbName"
)

foreach ($t in $Targets) {
    New-Item -Path $t -Force | Out-Null
    Set-ItemProperty -Path $t -Name "(Default)" -Value $Label
    if ($IconHint) {
        Set-ItemProperty -Path $t -Name "Icon" -Value $IconHint
    }
    $cmdKey = Join-Path $t "command"
    New-Item -Path $cmdKey -Force | Out-Null
    Set-ItemProperty -Path $cmdKey -Name "(Default)" -Value $CmdLine
    Write-Host "  [OK] $t" -ForegroundColor Green
}

Write-Host ""
Write-Host "[OK] Explorer 右クリック「$Label」を登録しました。" -ForegroundColor Green
Write-Host "     (フォルダ右クリック / フォルダ空白部右クリック どちらでも有効)"
Write-Host ""
Write-Host "Explorer の再起動は不要ですが、反映されない場合は" -ForegroundColor Yellow
Write-Host "タスクマネージャーから explorer.exe を再起動してください。"
Write-Host ""

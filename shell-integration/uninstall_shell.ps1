# Remove Explorer right-click "Drive で開く" registration.

$ErrorActionPreference = "SilentlyContinue"
$VerbName = "DriveToExplorer"
$Targets = @(
    "HKCU:\Software\Classes\Directory\shell\$VerbName",
    "HKCU:\Software\Classes\Directory\Background\shell\$VerbName"
)
foreach ($t in $Targets) {
    if (Test-Path $t) {
        Remove-Item -Path $t -Recurse -Force
        Write-Host "  [OK] removed $t" -ForegroundColor Green
    } else {
        Write-Host "  [skip] not present: $t" -ForegroundColor DarkGray
    }
}
Write-Host ""
Write-Host "Done." -ForegroundColor Yellow

# Drive to Explorer - Native Messaging Host installer
#
# Prompts for the extension ID, rewrites native-host/manifest.json's
# allowed_origins, and registers the host under HKCU for all
# Chromium-based browsers (Chrome / Edge / Brave / Vivaldi / Chromium).
#
# Usage:
#   .\install.ps1                        # 既定 ID を自動採用 (無プロンプト)
#   .\install.ps1 <extensionId>          # 指定 ID を使用
#   .\install.ps1 -Interactive           # 既定 ID があっても対話で確認

param(
    [string]$ExtensionId,
    # 既定 ID が manifest.json から読めても、あえて対話で確認したい場合に指定する
    [switch]$Interactive
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Manifest = Join-Path $ScriptDir "manifest.json"
$HostName = "com.yato.drive_to_explorer"

if (-not (Test-Path $Manifest)) {
    Write-Host "[ERROR] manifest.json not found: $Manifest" -ForegroundColor Red
    exit 1
}

# Prompt if not given.
# v0.2.0+ では manifest.key により拡張機能 ID は配布パッケージで固定なので、
# manifest.json から既存の ID を読んで「Enter で承認」できるようにする。
if (-not $ExtensionId -or $ExtensionId.Trim() -eq "") {
    $defaultId = $null
    try {
        $raw = Get-Content -Raw -Path $Manifest -Encoding UTF8
        if ($raw -match 'chrome-extension://([a-p]{32})/') {
            $defaultId = $matches[1]
        }
    } catch {}

    if ($defaultId -and -not $Interactive) {
        # 既定 ID があるなら聞かずに採用する。
        # manifest.key により配布版の拡張機能 ID は不変なので、通常これで正しい。
        # 別 ID を使いたい場合のみ -Interactive か第 1 引数で明示する。
        Write-Host ""
        Write-Host "拡張機能 ID: $defaultId (固定化済みのため自動採用)" -ForegroundColor Green
        $ExtensionId = $defaultId
    } elseif ($defaultId) {
        Write-Host ""
        Write-Host "拡張機能 ID は固定化済みです: $defaultId" -ForegroundColor Green
        Write-Host "  (manifest.key により配布版で同一 ID。通常そのままで OK)"
        Write-Host ""
        $userInput = Read-Host "Extension ID (Enter で既定値 $defaultId を使用)"
        if ($userInput -and $userInput.Trim() -ne "") {
            $ExtensionId = $userInput
        } else {
            $ExtensionId = $defaultId
        }
    } else {
        Write-Host ""
        Write-Host "拡張機能 ID を入力してください。" -ForegroundColor Cyan
        Write-Host "  ブラウザの拡張オプション画面 (Drive to Explorer) に表示されています。"
        Write-Host "  または brave://extensions / chrome://extensions / edge://extensions で"
        Write-Host "  デベロッパーモードを ON にすると確認できます。"
        Write-Host ""
        $ExtensionId = Read-Host "Extension ID"
    }
}

$ExtensionId = $ExtensionId.Trim()

# Validate (32 chars, lowercase a-p)
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Host ""
    Write-Host "[ERROR] 無効な拡張機能 ID 形式: '$ExtensionId'" -ForegroundColor Red
    Write-Host "        32 文字の小文字英字 (a-p) を期待しています。"
    exit 1
}

# Substitute allowed_origins in manifest.json
$content = Get-Content -Raw -Path $Manifest -Encoding UTF8
$newOrigin = "chrome-extension://$ExtensionId/"
$updated = $content -replace 'chrome-extension://[^/]+/', $newOrigin

# Write back (UTF-8, no BOM)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($Manifest, $updated, $utf8NoBom)

Write-Host ""
Write-Host "[OK] manifest.json を更新しました" -ForegroundColor Green
Write-Host "     allowed_origins -> $newOrigin"
Write-Host ""

# Register in HKCU for all Chromium-based browsers
$Browsers = @(
    @{ Name = "Chrome";   Path = "Software\Google\Chrome" },
    @{ Name = "Edge";     Path = "Software\Microsoft\Edge" },
    @{ Name = "Brave";    Path = "Software\BraveSoftware\Brave-Browser" },
    @{ Name = "Vivaldi";  Path = "Software\Vivaldi" },
    @{ Name = "Chromium"; Path = "Software\Chromium" }
)

$okCount = 0
foreach ($b in $Browsers) {
    $regKey = "HKCU\$($b.Path)\NativeMessagingHosts\$HostName"
    & reg add $regKey /ve /t REG_SZ /d $Manifest /f | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] $($b.Name)" -ForegroundColor Green
        $okCount++
    } else {
        Write-Host "  [FAIL] $($b.Name)" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($okCount -eq 0) {
    # 呼び出し元 (setup.ps1) が終了コードだけで成否を判定できるようにする。
    # ループ最後の reg add の $LASTEXITCODE を見ると、未インストールのブラウザでも
    # reg add は成功するため常に 0 になり判定が無意味になる。
    Write-Host "[ERROR] どのブラウザにも登録できませんでした。" -ForegroundColor Red
    exit 1
}

Write-Host "完了しました。ブラウザを完全終了して再起動してください。" -ForegroundColor Yellow
Write-Host "  (タスクマネージャーで chrome.exe / brave.exe / msedge.exe 等が残っていないことを確認)"
Write-Host ""

exit 0


# Drive to Explorer - 自動更新スクリプト
#
# 動作:
#   1. GitHub Releases API から最新の release zip URL を取得
#   2. 既にそのバージョンがインストール済みなら何もしない (force スイッチで強制)
#   3. zip を一時フォルダに DL → 解凍
#   4. このスクリプトと同じフォルダ (= 既存インストール先) に上書き展開
#   5. native-host/install.bat を引数なしで自動実行 (拡張ID 既定値を承認)
#   6. ブラウザ再起動を案内
#
# 使い方:
#   このスクリプトと同じディレクトリ (extension/ や native-host/ が並ぶ場所) で
#   update.bat をダブルクリック。または直接:
#     powershell -ExecutionPolicy Bypass -File update.ps1
#
# パラメータ:
#   -Force         同一バージョンでも再展開
#   -Repo <owner/repo>  既定: hakuseiyato/drive-to-explorer
#   -Channel <tag|prerelease|latest>  既定: latest

param(
    [switch]$Force,
    [string]$Repo = "hakuseiyato/drive-to-explorer",
    [string]$Channel = "latest"
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

Write-Host ""
Write-Host "=== Drive to Explorer 自動更新 ===" -ForegroundColor Cyan
Write-Host "  インストール先: $ScriptDir"
Write-Host ""

# ---- 現在のバージョンを取得 -----------------------------------------------
$LocalManifest = Join-Path $ScriptDir "extension\manifest.json"
$LocalVersion = $null
if (Test-Path $LocalManifest) {
    try {
        $m = Get-Content -Raw -Path $LocalManifest -Encoding UTF8 | ConvertFrom-Json
        $LocalVersion = $m.version
        Write-Host "  現在のバージョン: $LocalVersion"
    } catch {
        Write-Host "  現在のバージョン: 不明 (manifest.json 解析失敗)" -ForegroundColor Yellow
    }
} else {
    Write-Host "  現在のバージョン: なし (新規インストール)" -ForegroundColor Yellow
}

# ---- 最新リリース情報を取得 -----------------------------------------------
$apiUrl = if ($Channel -eq "latest") {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Repo/releases/tags/$Channel"
}

Write-Host "  リリース情報取得中: $apiUrl"
try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ "User-Agent" = "DriveToExplorer-Updater" }
} catch {
    Write-Host "[ERROR] リリース情報取得失敗: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host "Enter で終了"
    exit 1
}

$latestTag = $release.tag_name
$latestVer = $latestTag -replace '^v', ''
Write-Host "  最新バージョン: $latestVer (tag: $latestTag)"
Write-Host ""

# ---- バージョン比較 -------------------------------------------------------
if (-not $Force -and $LocalVersion -and $LocalVersion -eq $latestVer) {
    Write-Host "[OK] 既に最新版です: $LocalVersion" -ForegroundColor Green
    Write-Host "     再展開する場合は: update.bat -Force"
    Read-Host "Enter で終了"
    exit 0
}

# ---- zip アセットを探す ---------------------------------------------------
$asset = $release.assets | Where-Object { $_.name -match '^drive-to-explorer-.*\.zip$' } | Select-Object -First 1
if (-not $asset) {
    Write-Host "[ERROR] リリースアセットに zip が見つかりません" -ForegroundColor Red
    Read-Host "Enter で終了"
    exit 1
}
$zipUrl = $asset.browser_download_url
$zipName = $asset.name
Write-Host "  ダウンロード: $zipName"

# ---- 一時ディレクトリへ DL ------------------------------------------------
$tmpDir = Join-Path $env:TEMP "dte-update-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$tmpZip = Join-Path $tmpDir $zipName

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing -Headers @{ "User-Agent" = "DriveToExplorer-Updater" }
} catch {
    Write-Host "[ERROR] zip ダウンロード失敗: $($_.Exception.Message)" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    Read-Host "Enter で終了"
    exit 1
}

Write-Host "  解凍中..."
$extractDir = Join-Path $tmpDir "extract"
Expand-Archive -Path $tmpZip -DestinationPath $extractDir -Force

# zip の中身は drive-to-explorer-<version>/ サブディレクトリ
$nestedDir = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
if (-not $nestedDir) {
    Write-Host "[ERROR] zip の中身が想定外です" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    Read-Host "Enter で終了"
    exit 1
}

# ---- ブラウザが起動中だと .exe を上書きできない可能性があるので警告 ----
$browserProcs = @("chrome", "msedge", "brave", "vivaldi", "chromium") |
    ForEach-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue } |
    Where-Object { $_ -ne $null }
if ($browserProcs) {
    Write-Host ""
    Write-Host "[警告] 以下のブラウザが起動中です:" -ForegroundColor Yellow
    $browserProcs | Select-Object -ExpandProperty Name -Unique | ForEach-Object { Write-Host "  - $_" }
    Write-Host "       Native Host .exe の上書きに失敗する可能性があります。"
    Write-Host "       ブラウザを終了してから再実行することを推奨します。"
    Write-Host ""
    $resp = Read-Host "それでも続行しますか? (y/N)"
    if ($resp -notmatch '^[yY]') {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
        exit 0
    }
}

# ---- 上書き展開 -----------------------------------------------------------
Write-Host "  展開: $($nestedDir.FullName) -> $ScriptDir"

# 除外: update.ps1 / update.bat 自身は新しいバージョンの内容で上書きされて構わない
# 除外: 個人鍵フォルダ .keys/ は触らない
$excludeDirs = @(".keys")

Get-ChildItem -Path $nestedDir.FullName -Force | ForEach-Object {
    if ($excludeDirs -contains $_.Name) {
        Write-Host "  [skip] $($_.Name)" -ForegroundColor DarkGray
        return
    }
    $dest = Join-Path $ScriptDir $_.Name
    try {
        if ($_.PSIsContainer) {
            Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
        } else {
            Copy-Item -Path $_.FullName -Destination $dest -Force
        }
        Write-Host "  [OK] $($_.Name)" -ForegroundColor Green
    } catch {
        Write-Host "  [FAIL] $($_.Name): $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ---- クリーンアップ -------------------------------------------------------
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

# ---- install.bat を再実行 (拡張ID は manifest 内既定値を採用) ------------
Write-Host ""
Write-Host "  Native Host を再登録 (install.ps1)..."
$installPs1 = Join-Path $ScriptDir "native-host\install.ps1"
if (Test-Path $installPs1) {
    # install.ps1 を引数なしで呼び、内部で manifest.json の既定 ID を採用させる
    # 一括承認: 内部の Read-Host を bypass するため、空文字を stdin 経由で流す
    "" | & powershell -NoProfile -ExecutionPolicy Bypass -File $installPs1
} else {
    Write-Host "[警告] $installPs1 が見つかりません" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== 更新完了 ===" -ForegroundColor Green
Write-Host "  $LocalVersion -> $latestVer" -ForegroundColor Green
Write-Host ""
Write-Host "次の手順:" -ForegroundColor Cyan
Write-Host "  1. ブラウザを完全終了 (タスクマネージャーで brave.exe / chrome.exe 等が残っていないか確認)"
Write-Host "  2. ブラウザを再起動"
Write-Host "  3. brave://extensions / chrome://extensions で Drive to Explorer の「↻ 再読み込み」を押す"
Write-Host "     (manifest.key により拡張機能 ID は不変)"
Write-Host "  4. オプション画面で OAuth サインインが切れている場合は「サインイン」を押し直す"
Write-Host ""
Read-Host "Enter で終了"

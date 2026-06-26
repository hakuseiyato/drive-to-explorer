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

# PowerShell 5.1 は既定で古い TLS を使い GitHub への接続に失敗することがあるため TLS1.2 を強制
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

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

# ---- 上書き展開 (ファイル単位・使用中はリトライ) --------------------------
# 事前のブラウザ起動チェックは行わない:
#   Edge 等はバックグラウンド常駐でプロセスが残るため誤検出になり、
#   かつ Native Host .exe はメッセージ受信時のみの短命プロセスなので
#   常駐していても上書きできることがほとんど。実際に失敗したファイルだけ警告する。
Write-Host "  展開: $($nestedDir.FullName) -> $ScriptDir"

# 除外（トップレベル名で判定）:
#   .keys      個人鍵フォルダは触らない
#   update.bat 実行中の自分自身。上書きすると cmd が再開時にオフセットずれで破損しうる
#              (update.ps1 は PowerShell が起動時に全文ロード済みなので上書きしても安全)
$excludeTop = @(".keys", "update.bat")

# 使用中ファイルはリトライしながらコピーする
function Copy-FileWithRetry {
    param([string]$Src, [string]$Dst, [int]$Retries = 3, [int]$DelaySec = 2)
    for ($i = 1; $i -le $Retries; $i++) {
        try {
            $parent = Split-Path -Parent $Dst
            if ($parent -and -not (Test-Path $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            Copy-Item -LiteralPath $Src -Destination $Dst -Force
            return $true
        } catch {
            if ($i -lt $Retries) { Start-Sleep -Seconds $DelaySec } else { return $false }
        }
    }
}

$rootLen = $nestedDir.FullName.Length
$script:failed = @()

Get-ChildItem -Path $nestedDir.FullName -Force | ForEach-Object {
    if ($excludeTop -contains $_.Name) {
        Write-Host "  [skip] $($_.Name)" -ForegroundColor DarkGray
        return
    }
    if ($_.PSIsContainer) {
        $before = $script:failed.Count
        Get-ChildItem -Path $_.FullName -Recurse -File -Force | ForEach-Object {
            $rel = $_.FullName.Substring($rootLen).TrimStart('\')
            $dst = Join-Path $ScriptDir $rel
            if (-not (Copy-FileWithRetry -Src $_.FullName -Dst $dst)) {
                $script:failed += $rel
            }
        }
        if ($script:failed.Count -eq $before) {
            Write-Host "  [OK] $($_.Name)\" -ForegroundColor Green
        } else {
            Write-Host "  [一部失敗] $($_.Name)\" -ForegroundColor Yellow
        }
    } else {
        $dst = Join-Path $ScriptDir $_.Name
        if (Copy-FileWithRetry -Src $_.FullName -Dst $dst) {
            Write-Host "  [OK] $($_.Name)" -ForegroundColor Green
        } else {
            $script:failed += $_.Name
        }
    }
}

if ($script:failed.Count -gt 0) {
    Write-Host ""
    Write-Host "[警告] 以下のファイルは使用中で上書きできませんでした:" -ForegroundColor Yellow
    $script:failed | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "       ブラウザ (Edge/Chrome/Brave 等) を完全終了してから update.bat を再実行してください。" -ForegroundColor Yellow
    Write-Host "       タスクマネージャーで msedge.exe / chrome.exe が残っていないか確認すると確実です。" -ForegroundColor Yellow
    Write-Host ""
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

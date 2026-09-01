# Drive to Explorer - 初回セットアップ (配布先の未経験者向け 1 本化スクリプト)
#
# 実行内容:
#   1. 展開場所が更新に適しているか点検
#   2. Native Messaging Host をレジストリ登録 (無プロンプト)
#   3. Drive for desktop のミラールート候補を自動検出して表示
#   4. インストール済みブラウザの拡張機能ページ URL と extension フォルダの
#      絶対パスを表示し、パスをクリップボードへコピー
#   5. 配布先向けガイド (docs/index.html) を既定ブラウザで開く
#
# Usage:
#   .\setup.ps1            # 通常
#   .\setup.ps1 -NoGuide   # ガイドを開かない

param(
    [switch]$NoGuide
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }

function Write-Step($n, $text) {
    Write-Host ""
    Write-Host "== $n. $text ==" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "Drive to Explorer セットアップ" -ForegroundColor White
Write-Host "  インストール先: $Root"

# --- 1. 展開場所の点検 --------------------------------------------------
# バージョン番号入りフォルダや Downloads / Temp 配下に置くと、更新のたびに
# Native Host のレジストリパスが変わって再登録が必要になる。
Write-Step 1 "展開場所の点検"
$warn = @()
if ($Root -match '[\\/](Downloads|Temp|AppData)[\\/]') {
    $warn += "Downloads / Temp / AppData 配下に置かれています"
}
if ((Split-Path -Leaf $Root) -match 'v?\d+\.\d+') {
    $warn += "フォルダ名にバージョン番号が含まれています"
}
if ($warn.Count -gt 0) {
    foreach ($w in $warn) { Write-Host "  [警告] $w" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "  更新のたびに再セットアップが必要になります。" -ForegroundColor Yellow
    Write-Host "  C:\Tools\drive-to-explorer\ のような固定パスへ移動してから" -ForegroundColor Yellow
    Write-Host "  実行し直すことを推奨します。" -ForegroundColor Yellow
    Write-Host ""
    $ans = Read-Host "  このまま続行しますか? (y/N)"
    if ($ans -notmatch '^[yY]') {
        Write-Host "  中断しました。" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host "  [OK] 問題ありません" -ForegroundColor Green
}

# --- 2. Native Host 登録 -------------------------------------------------
Write-Step 2 "Native Messaging Host の登録"
$installPs1 = Join-Path $Root "native-host\install.ps1"
if (-not (Test-Path $installPs1)) {
    Write-Host "  [ERROR] native-host\install.ps1 が見つかりません" -ForegroundColor Red
    exit 1
}
# install.ps1 は「1 つも登録できなかったとき」だけ exit 1 する
& $installPs1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] Native Host の登録に失敗しました" -ForegroundColor Red
    exit 1
}

# --- 3. ローカルルート候補の自動検出 ------------------------------------
# 拡張側 (options 画面) でも同じ検出を Native Host 経由で行うが、
# ここで先に見せておくと「何を設定させられるのか」が分かって迷いが減る。
Write-Step 3 "Drive for desktop のミラールート検出"
$markers = @("マイドライブ", "My Drive", "共有ドライブ", "Shared drives")
$found = @()
# 全ドライブレターを Test-Path で総当たりすると、切断済みネットワークドライブで
# 数十秒ブロックする。準備完了しているドライブだけを対象にする
# (目印フォルダの判定条件は native-host/drive_to_explorer_host.py の
#  _DRIVE_MARKERS と揃えること)。
$bases = @()
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    if ($d.IsReady) { $bases += $d.RootDirectory.FullName }
}
if ($env:USERPROFILE) { $bases += $env:USERPROFILE }
foreach ($b in $bases) {
    if (-not (Test-Path -LiteralPath $b)) { continue }
    $hit = @()
    foreach ($m in $markers) {
        if (Test-Path -LiteralPath (Join-Path $b $m)) { $hit += $m }
    }
    if ($hit.Count -gt 0) {
        $found += $b
        Write-Host "  [検出] $b  ($($hit -join ' / '))" -ForegroundColor Green
    }
}
if ($found.Count -eq 0) {
    Write-Host "  [!] 見つかりませんでした" -ForegroundColor Yellow
    Write-Host "      Drive for desktop がインストール・同期済みか確認してください。"
    Write-Host "      後からオプション画面の「自動検出」でやり直せます。"
} else {
    Write-Host ""
    Write-Host "  拡張の初回起動時にこれらが自動設定されます (手入力は不要)。"
}

# --- 4. 拡張機能の読み込み案内 ------------------------------------------
Write-Step 4 "ブラウザへの拡張機能の読み込み"
$extDir = Join-Path $Root "extension"
$browsers = @(
    @{ Name = "Chrome";   Reg = "Software\Google\Chrome";                 Url = "chrome://extensions" },
    @{ Name = "Edge";     Reg = "Software\Microsoft\Edge";                Url = "edge://extensions" },
    @{ Name = "Brave";    Reg = "Software\BraveSoftware\Brave-Browser";   Url = "brave://extensions" },
    @{ Name = "Vivaldi";  Reg = "Software\Vivaldi";                       Url = "vivaldi://extensions" }
)
$installed = @()
foreach ($b in $browsers) {
    if (Test-Path -LiteralPath "HKCU:\$($b.Reg)") { $installed += $b }
}

Write-Host "  次の手順をブラウザ側で 1 回だけ行ってください:"
Write-Host ""
if ($installed.Count -gt 0) {
    Write-Host "    (1) アドレスバーに次のいずれかを入力して開く"
    foreach ($b in $installed) {
        Write-Host "          $($b.Url)".PadRight(34) -NoNewline
        Write-Host "  <- $($b.Name)" -ForegroundColor DarkGray
    }
} else {
    Write-Host "    (1) chrome://extensions (Edge は edge://extensions 等) を開く"
}
Write-Host "    (2) 右上の「デベロッパーモード」を ON"
Write-Host "    (3) 「パッケージ化されていない拡張機能を読み込む」をクリック"
Write-Host "    (4) 次のフォルダを選択:"
Write-Host ""
Write-Host "          $extDir" -ForegroundColor White
Write-Host ""

try {
    Set-Clipboard -Value $extDir
    Write-Host "  [OK] 上記のパスをクリップボードにコピーしました" -ForegroundColor Green
    Write-Host "       フォルダ選択ダイアログのアドレス欄に Ctrl+V で貼り付けられます"
} catch {
    Write-Host "  [!] クリップボードへのコピーに失敗しました (手入力してください)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "    (5) 読み込み後、ブラウザを完全終了して再起動" -ForegroundColor Yellow
Write-Host "        (Native Host はブラウザ起動時にしか読み込まれないため必須)"
Write-Host "    (6) 拡張アイコン右クリック -> オプション -> 「サインイン」" -ForegroundColor Yellow
Write-Host "        (Drive API 連携。open?id=... 形式のリンク解決に必要)"

# --- 5. ガイドを開く -----------------------------------------------------
$guide = Join-Path $Root "docs\index.html"
if (-not $NoGuide -and (Test-Path -LiteralPath $guide)) {
    Write-Step 5 "配布先向けガイドを開きます"
    Start-Process $guide
}

Write-Host ""
Write-Host "セットアップスクリプトの処理は完了しました。" -ForegroundColor Green
Write-Host "残りは上記 (1)-(6) のブラウザ側操作だけです。"
Write-Host ""

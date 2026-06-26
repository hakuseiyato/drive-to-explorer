# =============================================================================
# Drive to Explorer - 自動アップデーター
# =============================================================================
# Native Host (drive_to_explorer_host) から **デタッチ起動** される。
# 拡張UIの「今すぐ更新」ボタン → Host {action:"update"} → 本スクリプト。
#
# 役割:
#   1. GitHub Releases から最新版 zip をダウンロード
#   2. 一時領域に展開
#   3. 起動元ホストプロセスの終了を待つ（実行中 exe のロック解放）
#   4. インストールルートへ全ファイルを上書き展開（exe 含む、ロック時リトライ）
#   5. 進捗を StatusFile(JSON) に逐次書き込み（拡張がポーリングで読む）
#
# 完了後、拡張側が chrome.runtime.reload() を呼ぶことで新バージョンが反映される。
# （ブラウザ再起動・コピペ・bat 実行はいずれも不要）
# =============================================================================

param(
  [string]$Repo = "hakuseiyato/drive-to-explorer",
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$StatusFile,
  [int]$HostPid = 0
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 では既定で TLS1.2 が無効な場合があるため明示有効化
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# ---- 進捗書き込み -----------------------------------------------------------
function Write-Status {
  param([string]$State, [hashtable]$Extra)
  $obj = @{ state = $State; ts = (Get-Date).ToString("o") }
  if ($Extra) { foreach ($k in $Extra.Keys) { $obj[$k] = $Extra[$k] } }
  try {
    $dir = Split-Path -Parent $StatusFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    ($obj | ConvertTo-Json -Compress) | Set-Content -Path $StatusFile -Encoding UTF8
  } catch { }
}

try {
  $work    = Join-Path $env:TEMP "dte_update"
  $zipPath = Join-Path $work "release.zip"
  $stage   = Join-Path $work "staging"
  $headers = @{ "User-Agent" = "DriveToExplorer-Updater" }

  if (-not (Test-Path $work)) { New-Item -ItemType Directory -Force -Path $work | Out-Null }

  # 1. 最新リリース情報を取得 ----------------------------------------------
  Write-Status "downloading" @{ repo = $Repo }
  $api = "https://api.github.com/repos/$Repo/releases/latest"
  $rel = Invoke-RestMethod -Uri $api -Headers $headers
  $ver = ($rel.tag_name -replace '^v', '')
  $asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
  if (-not $asset) { throw "最新リリースに zip アセットが見つかりません" }

  # 2. zip ダウンロード ----------------------------------------------------
  Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $zipPath

  # 3. 展開 ----------------------------------------------------------------
  Write-Status "extracting" @{ version = $ver }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Expand-Archive -Path $zipPath -DestinationPath $stage -Force

  # zip 内のトップフォルダ (drive-to-explorer-vX.Y.Z) を解決。
  # 直下に extension/ が無い構成なら 1 階層潜る。
  $src = $stage
  if (-not (Test-Path (Join-Path $src "extension"))) {
    $top = Get-ChildItem -Path $stage -Directory | Select-Object -First 1
    if ($top) { $src = $top.FullName }
  }
  if (-not (Test-Path (Join-Path $src "extension"))) {
    throw "展開結果に extension/ が見つかりません: $src"
  }

  # 4. 起動元ホスト終了待ち（実行中 exe のロック解放） ----------------------
  Write-Status "waiting" @{ version = $ver }
  if ($HostPid -gt 0) {
    try { Wait-Process -Id $HostPid -Timeout 20 -ErrorAction SilentlyContinue } catch { }
  }
  Start-Sleep -Milliseconds 800

  # 5. ファイル入替（上書き） ----------------------------------------------
  Write-Status "swapping" @{ version = $ver }

  # サブフォルダは robocopy /E でコピー。/R /W でロック時リトライ。
  # （/MIR や /PURGE は使わない＝ユーザー生成物を消さない安全側）
  $dirs = @('extension', 'native-host', 'shell-integration', 'docs')
  foreach ($d in $dirs) {
    $s = Join-Path $src $d
    if (Test-Path $s) {
      $t = Join-Path $InstallRoot $d
      # robocopy は成功でも 0-7 を返すため $LASTEXITCODE は判定しない
      robocopy $s $t /E /R:15 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    }
  }

  # ルート直下ファイル
  foreach ($f in @('README.md', 'update.ps1', 'update.bat')) {
    $s = Join-Path $src $f
    if (Test-Path $s) {
      Copy-Item -Path $s -Destination (Join-Path $InstallRoot $f) -Force -ErrorAction SilentlyContinue
    }
  }

  Write-Status "done" @{ version = $ver }
}
catch {
  Write-Status "error" @{ error = $_.Exception.Message }
}

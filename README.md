# Drive to Explorer

Google Drive (Web) で開いているフォルダを、ワンクリックで Windows エクスプローラーの対応するローカルフォルダ (Drive for desktop のミラー先) として開く Chromium 系ブラウザ拡張。

ブラウザのサンドボックスから直接 `explorer.exe` は起動できないため、**ブラウザ拡張 (Manifest V3) + Native Messaging Host (Python)** の構成で実現しています。

対応ブラウザ: Chrome / Edge / Brave / Vivaldi / Chromium
対応 OS: Windows 10 / 11

> 📖 **配布先向けガイド**: セットアップ・更新・権限を 1 枚にまとめた [`docs/index.html`](docs/index.html) をブラウザで開いてください（zip 同梱）。
>
> 🔄 **v0.3.0+**: オプション画面の「今すぐ更新」ボタンから、**UI だけでアップデート→自動再読み込み**が可能になりました（bat 実行・コピペ・ブラウザ再起動は不要）。

---

## 仕組み (要約)

1. Drive Web 上で「フォルダ情報 → エクスプローラーで開く」を選ぶ、または拡張アイコンの popup から開く
2. content script が「**パスを表示**」ボタンを内部的にクリックして折り畳まれた祖先フォルダを取得し、breadcrumb バー上の可視祖先と現在フォルダを連結して**完全なフォルダ階層**を組み立てる
3. background が「ローカルルートパス」の配下で `<root>\` `<root>\共有ドライブ\` `<root>\マイドライブ\` (および英語版) を順に試行
4. 存在するパスを Native Messaging で Python ホストに送信
5. Python ホストが `explorer.exe <path>` を起動

---

## ディレクトリ構成

```
drive-to-explorer/
├── extension/                   # ブラウザ拡張 (Manifest V3)
│   ├── manifest.json
│   ├── background.js            # Native Messaging / コンテキストメニュー / popup ルーティング
│   ├── content.js               # Drive UI 解析 / パス取得 / メニュー注入
│   ├── popup.html / popup.js    # ツールバーアイコン押下時の UI
│   ├── options.html / options.js # 設定画面 (ローカルルートパス)
│   └── icons/                   # 16 / 48 / 128 px PNG
├── native-host/
│   ├── drive_to_explorer_host.py  # stdin/stdout プロトコル + explorer 起動
│   ├── drive_to_explorer_host.bat # Python 呼び出しラッパー (Chrome から起動される実体)
│   ├── manifest.json              # Native Messaging Host マニフェスト
│   ├── install.bat                # レジストリ登録
│   └── uninstall.bat              # レジストリ削除
└── README.md
```

---

## セットアップ

### 推奨インストール先

将来の更新を楽にするため、**バージョン無しの安定パス** に展開することを推奨します:

```
F:\Tools\drive-to-explorer\
```

（ドライブレターや配置先は任意ですが、バージョン番号を含まないフォルダ名にしてください）

zip を `drive-to-explorer-v0.2.1/` のようなバージョン入りフォルダのまま使うと、更新のたびに Native Host のレジストリパスが変わり再登録が必要になります。安定フォルダなら `update.bat` で上書き更新 → Native Host も自動再登録できます。

### 前提
- **Drive for desktop** がインストールされ、ドライブレター (例: `I:\`) でマウントされていること
- 以下のいずれかを満たすこと:
  - **Python 3** がインストール済みで、`py` または `python` で起動できる（確認: `py -3 -V` または `python -V`）
  - もしくは事前ビルド済みの `native-host/drive_to_explorer_host.exe` が同梱されている（リリース zip には同梱済み）

### 1. 拡張機能を読み込む

1. ブラウザの拡張機能ページを開く
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Vivaldi: `vivaldi://extensions`
2. 右上の **「デベロッパーモード」を ON**
3. **「パッケージ化されていない拡張機能を読み込む」** → このリポジトリの `extension/` フォルダを選択
4. 表示される **拡張機能 ID** は **`pkiecgchhhhcgnjjgofmlfobbhacdcge`** に固定されます
   - v0.2.0+ で `manifest.key` により ID が固定化されているため、別 PC でロードしても同じ ID になります
   - 配布パッケージや GCP の OAuth 設定が「1回だけ」で全マシンに通用

### 2. Native Host を登録

`install.bat` を実行すると、manifest.json の `allowed_origins` 確認 → 全ブラウザレジストリ登録までを行います。

1. `native-host/install.bat` をダブルクリック
2. プロンプトで `Extension ID:` と聞かれます
   - v0.2.0+ では拡張機能 ID `pkiecgchhhhcgnjjgofmlfobbhacdcge` が既定値として表示されるので **Enter キーだけで承認**
   - 別 ID で登録したい場合のみ入力
3. Chrome / Edge / Brave / Vivaldi / Chromium の HKCU レジストリに自動登録
4. **ブラウザを完全終了** → 再起動
   - タスクマネージャーで `<browser>.exe` プロセスが残っていないか確認

> **コマンドライン引数も可**: `install.bat <extension_id>` のように直接渡せます。プロンプトが省略されます。

### 3. ローカルルートパスを設定

1. 拡張アイコンを右クリック → 「オプション」 (または `chrome://extensions` → 詳細 → 拡張機能のオプション)
2. **ローカルルートパス** に Drive for desktop のドライブレターを入力 (例: `I:\`)
3. 「ルート存在チェック」 → 「保存」

> **パス解決について**: Drive for desktop は共有ドライブを `<root>\共有ドライブ\<drive名>\...`、マイドライブを `<root>\マイドライブ\...` 配下にミラーします。本拡張はルートを起点に「直下」「`共有ドライブ\`」「`マイドライブ\`」（英語版 `Shared drives\` / `My Drive\` も）を**自動で順次試行**し、最初に存在するパスを開きます。なのでルートはドライブレターのみ (例: `I:\`) を指定すれば OK です。

---

### 4. OAuth サインイン (推奨)

v0.2.2+ から **配布版に既定の OAuth Client ID が同梱** されているので、通常は **「サインイン」ボタンを押すだけ** で API モードが使えるようになります。

1. 拡張オプション画面を開く（拡張アイコン右クリック → 「オプション」）
2. **Drive REST API (OAuth)** セクションの **「サインイン」** をクリック
3. 別タブで Google アカウント選択 → 「許可」
4. **「✓ サインイン済み (既定 Client ID 使用)」** が出れば完了

> **「このアプリは確認されていません」と警告が出る場合**: 「詳細」 → 「Drive to Explorer に移動」で進む。これは「Google 審査を通っていない自作アプリ」の標準警告で問題なし。

#### 独自の Client ID を使いたい場合 (任意)

組織内で独自の GCP プロジェクトで管理したい等の場合は、自分で OAuth Client ID を発行してオプション画面に貼り付けてください。詳細手順: [docs/GCP_SETUP.md](docs/GCP_SETUP.md)
（リダイレクト URI は `https://pkiecgchhhhcgnjjgofmlfobbhacdcge.chromiumapp.org/` 固定）

#### 簡単セットアップ (推奨): セットアップウィザード

1. 拡張オプション画面を開く
2. OAuth セクションの **「セットアップウィザードを開く」** をクリック
3. 5 ステップのモーダルに従って進む（各ステップで「Cloud Console を開く」が正しいページに直接ジャンプ、リダイレクト URI は自動でクリップボードにコピー）
4. 最後のステップでクライアント ID を貼り付け → 「保存してサインイン」

詳細手順 (ウィザードを使わない場合) は以下：

#### A. Google Cloud Console で OAuth クライアントを作成

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクト作成 (既存のものでも可)
2. **API ライブラリ** → 「Google Drive API」を有効化
3. **OAuth 同意画面** を構成
   - User Type: 外部
   - スコープ追加で `.../auth/drive.metadata.readonly` を追加 (検索: `drive.metadata.readonly`)
   - テストユーザーに自分の Gmail を追加
4. **認証情報** → **「OAuth クライアント ID を作成」** → 種類は **「ウェブ アプリケーション」**
5. **承認済みのリダイレクト URI** に拡張オプション画面に表示される URI を追加 (後述 B 参照)
   - 形式: `https://<extension_id>.chromiumapp.org/`
6. 発行された **クライアント ID** をコピー (例: `1234567890-abc...apps.googleusercontent.com`)

#### B. 拡張オプションに登録

1. 拡張オプション画面を開く
2. **「リダイレクト URI」欄の文字列**をコピー → Google Cloud のリダイレクト URI 欄に追加 (上記 5)
3. **「OAuth Client ID」**にコピーしたクライアント ID を貼り付け → 「Client ID 保存」
4. 「サインイン」ボタンをクリック → Google アカウント選択 → 権限承認
5. 「✓ サインイン済み」と出れば完了

> **挙動**: API は最優先で試行され、失敗時 (Client ID 未設定 / トークン失効 / オフライン) は自動的に DOM 解析にフォールバックします。
>
> **権限スコープ**: `drive.metadata.readonly` のみ — フォルダ名・親情報のみ参照。ファイル内容は読みません。

### 5. (任意) Explorer → Drive Web の逆方向

Windows Explorer 上でフォルダを右クリック → 「**Drive で開く**」で対応する Drive Web フォルダを開けるようになります。

> **前提**: ステップ 4 (OAuth 設定 + サインイン) を完了していること。Drive API でフォルダ階層を逆引きするため必須。

1. `shell-integration/install_shell.bat` をダブルクリック
   - `HKCU\Software\Classes\Directory\shell\DriveToExplorer` 配下にコンテキストメニュー登録 (管理者権限不要)
2. Explorer でフォルダを右クリック → 「Drive で開く」
   - Windows 11 では「**その他のオプションを表示**」配下に出ることがあります
3. ブラウザで Drive Web が開き、対応するフォルダに自動遷移

**仕組み**: 拡張は URL fragment `#dte_resolve=<encoded path>` を検知し、background が「`localRoot` を剥がす → `共有ドライブ`/`マイドライブ` プレフィックスを判定 → セグメントを順に Drive API で名前検索」してフォルダ ID を解決、`/drive/u/0/folders/<id>` に遷移します。

**アンインストール**: `shell-integration/uninstall_shell.bat`

### 6. (任意) Python 不要モード — `.exe` 化

配布先の PC に Python を入れたくない場合、**ビルド側で 1 度だけ** `.exe` を生成して同梱する：

1. ビルドする PC で `pip install pyinstaller` （初回のみ）
2. `native-host/build.bat` をダブルクリック実行
   - `pyinstaller --onefile --noconsole drive_to_explorer_host.py` 相当を実行
   - 同フォルダに `drive_to_explorer_host.exe` が生成される
3. 配布先には `extension/` と `native-host/`（`.exe` 入り）を渡せば OK
4. 配布先で `install.bat` を実行 → `drive_to_explorer_host.bat` は **`.exe` があれば優先**、無ければ Python にフォールバック

> ウイルス対策ソフトが PyInstaller の onefile を誤検出することがあります。除外設定するか、Python ありモードで運用してください。

---

## 使い方

### A. 右クリックメニュー (推奨・最も確実)

1. Drive Web でフォルダを表示
2. フォルダや空白部分で右クリック → 「フォルダ情報」 → **「エクスプローラーで開く」**
3. エクスプローラーで対応ローカルフォルダが開く

ファイルを右クリックした場合は、ファイルが選択された状態でエクスプローラーが開きます。

### B. ツールバーアイコン (popup)

1. Drive Web でフォルダを表示
2. ツールバーの拡張アイコンをクリック
3. Drive 階層・解決先のローカルパス候補が表示される
4. **「エクスプローラーで開く」** をクリック → 完全パスを取得してエクスプローラーが開く
5. もしくは **「パスをコピー」** でローカルパス文字列をクリップボードにコピー

### C. ローカルパスのコピーのみ

エクスプローラーで開かず、Slack 共有・スクリプト引数・他ツールへの貼り付け用にローカルパス文字列だけ欲しい場合：

- **右クリック → フォルダ情報 → 「ローカルパスをコピー」**
  - 解決後、画面右下にトーストで結果表示
  - クリップボード書込が失敗した場合はモーダルが出るので手動コピー
- **popup の「パスをコピー」ボタン**

---

## 技術メモ

### パス取得ロジック

Drive Web の現代 UI は breadcrumb を「**折り畳まれた祖先 (popup)**」と「**バー上の可視祖先**」に分けています。本拡張は両方を取得して連結：

```
[popup の中身: 2605_ISJ_ZeppHaneda, Work] + [バー可視: Yato] + [現在: TD]
= ['2605_ISJ_ZeppHaneda', 'Work', 'Yato', 'TD']
```

「パスを表示」ボタンは Drive の jsaction 経由で動作するため、`Element.click()` では反応しません。`PointerEvent / MouseEvent` の完全なシーケンス (`pointerdown → mousedown → pointerup → mouseup → click`) を bubbles + composed 付きで dispatch する `realClick()` で発火させています。

### user activation の伝播

popup から content script へ `chrome.tabs.sendMessage` で依頼すると Chrome の **user activation が失われ**、Drive UI が `realClick` を無視します。`chrome.scripting.executeScript({world:"MAIN"})` を popup の click ハンドラ内で同期的に呼ぶことで activation を保持。MAIN world から CustomEvent をディスパッチして isolated world の content script に渡しています。

### Native Messaging プロトコル

stdin に 4byte little-endian 長 + JSON、stdout に同形式（Chromium Native Messaging 仕様）。

- リクエスト: `{"action":"open"|"select"|"exists","path":"..."}`
- レスポンス: `{"ok":true}` / `{"ok":false,"error":"..."}` / `{"ok":true,"exists":true|false}`
- `path` はドライブレター始まりの絶対パスのみ受理。`..` を含むパスは拒否。

ホストのログ: `%TEMP%\drive_to_explorer_host.log`

---

## ツールバーアイコンのバッジ

ツールバーアイコンに小さなバッジが付くことがあります（5 分ごと + 設定変更時に自動更新）：

| バッジ | 状態 | 対応 |
|---|---|---|
| 🔴 `!` (赤) | ローカルルートパス未設定 | オプション画面で `I:\` 等を設定 |
| 🟠 `!` (橙) | Native Host 未登録 | `install.bat` を実行してブラウザ再起動 |
| (バッジ無し) | 動作可能 | アイコンにマウスを乗せると詳細 (OAuth モード等) が tooltip 表示 |

OAuth は任意機能なので未設定でもバッジは出ません。tooltip に `(DOM 解析モード)` 等で示されます。

---

## トラブルシューティング

### 「Native host has exited」/「Specified native messaging host not found」
- `native-host/manifest.json` の `allowed_origins` の拡張 ID が現在の拡張 ID と一致しているか確認
- `native-host/install.bat` を再実行 → ブラウザを完全終了して再起動
- レジストリ確認: `regedit` で
  `HKCU\Software\<Google\Chrome|BraveSoftware\Brave-Browser|Microsoft\Edge>\NativeMessagingHosts\com.yato.drive_to_explorer`
  の (規定) 値が `manifest.json` の絶対パスになっているか

### 何も起きない / エラー通知が出る
- Native Host のログを確認: `%TEMP%\drive_to_explorer_host.log`
- Python が PATH に通っているか: `py -3 -V` / `python -V`
- ブラウザの開発者ツール → 拡張の service worker / content script コンソールに `[DTE]` ログが出ているか

### 「ローカルパスが見つかりません」
- popup or 通知に「試したパス: ...」が表示される
- 該当パスが実際に Drive for desktop にミラーされているか確認
- 共有ドライブの場合: `<root>\共有ドライブ\<sharedDriveName>\...`
- 中間フォルダが Drive UI 上で「...」で省略されているケースは正しく解決されますが、稀に取りこぼす場合は **右クリックメニュー経由**を試してください

### Drive UI 変更でパンくずが取れなくなった
- `extension/content.js` の `getVisibleMidBreadcrumbs` / `readPathViaShowPath` / `getCurrentFolderName` を要更新
- DevTools コンソールで `[DTE] readPathViaShowPath: result= ...` の中身を確認すれば、どこで取れていないか判別できます

---

## 更新方法

### A. UI からワンクリック更新 (推奨・v0.3.0+)

オプション画面ヘッダーの **「今すぐ更新」** ボタンを押すだけ。**bat 実行・コピペ・ブラウザ再起動はすべて不要**です。

動作:
1. 拡張 → Native Host に `update` を送信
2. Native Host が `updater.ps1` を**デタッチ起動**して即応答（自身は終了し exe ロックを解放）
3. `updater.ps1` が GitHub Releases から最新 zip を DL → 展開 → 旧ホスト終了待ち → 全ファイル上書き（`extension/` `native-host/`(exe 含む) `shell-integration/` `docs/` `README.md`）
4. 進捗は `%TEMP%\dte_update\status.json` に記録され、拡張がポーリング表示
5. `done` を検知すると拡張が `chrome.runtime.reload()` で**自動再読み込み** → 新バージョン反映

> **仕組みのポイント**: ブラウザ拡張は自分自身のファイルを書き換えられないため、ファイル操作は OS 権限を持つ Native Host (`updater.ps1`) に委譲。実行中の exe は自分を上書きできないので、ホストは「起動役」に徹してすぐ終了し、updater が入れ替えます。Native Host は接続ごとに起動されるため、次回呼び出しで自動的に新 exe が使われます（ブラウザ再起動不要）。
>
> `manifest.key` により拡張機能 ID は不変なので、`chrome.storage.sync` の ローカルルートパスと OAuth Client ID は更新後も保持されます。OAuth セッションだけは切れることがあるので、必要なら「サインイン」を押し直してください。

### B. フォールバック: `update.bat`

UI 更新が失敗した場合（ネットワーク不調・ファイルロック等）に備え、従来の `update.bat` も残しています。インストールフォルダ直下の **`update.bat`** をダブルクリック → 最新版を取得・展開し `native-host/install.bat` まで自動実行します。

### C. 手動更新

1. [Releases](https://github.com/hakuseiyato/drive-to-explorer/releases) から最新 zip をダウンロード
2. 既存インストール先に上書き解凍
3. `native-host/install.bat` をダブルクリック → Enter で承認
4. ブラウザを完全終了 → 再起動 → `brave://extensions` で拡張の「↻ 再読み込み」

---

## アンインストール

1. ブラウザの拡張機能ページから「Drive to Explorer」を削除
2. `native-host/uninstall.bat` を実行 (HKCU レジストリから削除)

---

## スコープ外（将来拡張）

- Drive UI のローカライズ動的検出（現状は日本語/英語の文字列がハードコード、`extension/content.js` の `LOCALE_STRINGS` 集約は未実施）
- 完全な i18n (UI 文言の翻訳)
- macOS / Linux 対応
- 拡張機能の Chrome Web Store 公開（現状は Unpacked load 前提）

---

## サポートする URL パターン

| URL | 挙動 |
|---|---|
| `https://drive.google.com/drive/folders/<id>` | フォルダ → ローカル Explorer で開く |
| `https://drive.google.com/file/d/<id>/view` | ファイル単体プレビュー → ローカル同名ファイルがあれば選択、無ければ親フォルダを開く（OAuth セットアップ済みで有効）|
| `https://drive.google.com/open?id=<id>` | フォルダ ID として処理（API 経由で判別）|

> ファイル単体URL対応は v0.2.0 で追加。OAuth 未設定時は title からファイル名のみ抽出してフォールバック動作。

---

## キーボードショートカット

`chrome://extensions/shortcuts` (Edge は `edge://extensions/shortcuts` 等) で **「現在の Drive フォルダ（またはファイル）をエクスプローラーで開く」** にキー割当可能。

デフォルトは未割当（拡張間衝突を避けるため）。`Ctrl+Shift+E` 等の好みの組み合わせを設定。

---

## デバッグログ

オプション画面の「デバッグ」セクションで **「コンソールログ出力」** を ON にすると、Drive ページコンソールおよび Service Worker コンソールに `[DTE]` プレフィックス付きの詳細ログが出ます。

通常運用ではオフのままで OK。トラブル調査時のみ ON にして DevTools でログを確認します。

---

## リリース

`v*` パターンのタグを push すると、GitHub Actions が自動で：

1. `windows-latest` ランナー上で PyInstaller を使い `drive_to_explorer_host.exe` をビルド
2. `extension/` + `native-host/`（exe 入り）+ `shell-integration/` + `README.md` を一括 zip 化
3. Release を作成し zip をアセット添付（`gh release create --generate-notes`）

```bash
git tag v0.2.0
git push origin v0.2.0
```

タグ push 後 1〜2 分で `https://github.com/hakuseiyato/drive-to-explorer/releases` に zip が現れる。配布先には zip を渡すだけで Python 不要モードで動作する。

手動再生成は GitHub Actions UI の `Release` ワークフローを `workflow_dispatch` で起動。

---

## ライセンス

本リポジトリは個人/社内利用を想定したカスタムツールです。改変・再配布は自由ですが、保証はありません。

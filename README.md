# Drive to Explorer

Google Drive (Web) で開いているフォルダを、ワンクリックで Windows エクスプローラーの対応するローカルフォルダ (Drive for desktop のミラー先) として開く Chromium 系ブラウザ拡張。

ブラウザのサンドボックスから直接 `explorer.exe` は起動できないため、**ブラウザ拡張 (Manifest V3) + Native Messaging Host (Python)** の構成で実現しています。

対応ブラウザ: Chrome / Edge / Brave / Vivaldi / Chromium
対応 OS: Windows 10 / 11

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

### 前提
- **Drive for desktop** がインストールされ、ドライブレター (例: `I:\`) でマウントされていること
- 以下のいずれかを満たすこと:
  - **Python 3** がインストール済みで、`py` または `python` で起動できる（確認: `py -3 -V` または `python -V`）
  - もしくは事前ビルド済みの `native-host/drive_to_explorer_host.exe` が同梱されている（後述「Python 不要モード」参照）

### 1. 拡張機能を読み込む

1. ブラウザの拡張機能ページを開く
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Vivaldi: `vivaldi://extensions`
2. 右上の **「デベロッパーモード」を ON**
3. **「パッケージ化されていない拡張機能を読み込む」** → このリポジトリの `extension/` フォルダを選択
4. 表示された **拡張機能 ID** をコピー（例: `oabcdefghijklmnop1234567890abcdef`）

> **注意**: Unpacked load した拡張は、フォルダのパスやマシンによって ID が変わります。別マシンに配布する場合は再度 ID を控えて Step 2 の作業を行ってください。

### 2. Native Host を登録

1. `native-host/manifest.json` をテキストエディタで開く
2. `allowed_origins` の `REPLACE_WITH_EXTENSION_ID` を Step 1 でコピーした実 ID に置き換え：
   ```json
   {
     "name": "com.yato.drive_to_explorer",
     "description": "Drive (Web) -> Explorer launcher native host",
     "path": "drive_to_explorer_host.bat",
     "type": "stdio",
     "allowed_origins": [
       "chrome-extension://oabcdefghijklmnop1234567890abcdef/"
     ]
   }
   ```
   末尾の `/` を消さないこと、`chrome-extension://` プレフィックスは Brave 等でも変えない。
3. `native-host/install.bat` をダブルクリックで実行
   - Chrome / Edge / Brave / Vivaldi / Chromium の HKCU レジストリに登録
   - 成功すると `Done. Restart your browser to take effect.` と表示
4. **ブラウザを完全終了** → 再起動
   - タスクマネージャーで `<browser>.exe` プロセスが残っていないか確認

### 3. ローカルルートパスを設定

1. 拡張アイコンを右クリック → 「オプション」 (または `chrome://extensions` → 詳細 → 拡張機能のオプション)
2. **ローカルルートパス** に Drive for desktop のドライブレターを入力 (例: `I:\`)
3. 「ルート存在チェック」 → 「保存」

> **パス解決について**: Drive for desktop は共有ドライブを `<root>\共有ドライブ\<drive名>\...`、マイドライブを `<root>\マイドライブ\...` 配下にミラーします。本拡張はルートを起点に「直下」「`共有ドライブ\`」「`マイドライブ\`」（英語版 `Shared drives\` / `My Drive\` も）を**自動で順次試行**し、最初に存在するパスを開きます。なのでルートはドライブレターのみ (例: `I:\`) を指定すれば OK です。

---

### 4. (任意) Python 不要モード — `.exe` 化

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
4. **「エクスプローラーで開く」** をクリック → 一瞬パス popup がフラッシュした後、エクスプローラーが開く

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

## アンインストール

1. ブラウザの拡張機能ページから「Drive to Explorer」を削除
2. `native-host/uninstall.bat` を実行 (HKCU レジストリから削除)

---

## スコープ外（将来拡張）

- Drive REST API (OAuth) を使った folder ID → 正確なパス解決
- 共有ドライブ名の自動マッピング
- macOS / Linux 対応
- 拡張機能の Chrome Web Store 公開（現状は Unpacked load 前提）

---

## ライセンス

本リポジトリは個人/社内利用を想定したカスタムツールです。改変・再配布は自由ですが、保証はありません。

# Google Cloud OAuth セットアップガイド

このドキュメントは **Drive to Explorer** で Drive REST API を使うために必要な、Google Cloud Console での OAuth 2.0 クライアント ID 発行手順を解説します。

## 所要時間・料金

- **所要時間**: 約 5 分（初回のみ）
- **料金**: **完全無料**
  - GCP プロジェクト作成: 無料
  - Drive API 利用: 無料（個人用途では実質上限なし、`drive.metadata.readonly` スコープのみ使用）
  - クレジットカード登録: 不要
- **OAuth 同意画面**: 「テストモード」のままで OK、本番公開（Google 審査）は不要

## 前提

- **拡張機能 ID**: `pkiecgchhhhcgnjjgofmlfobbhacdcge` (v0.2.0+ で固定化)
- **リダイレクト URI**: `https://pkiecgchhhhcgnjjgofmlfobbhacdcge.chromiumapp.org/`

これらは配布パッケージ全体で同一なので、**Yato さんが1回設定すれば全ての配布先で同じクライアント ID が使えます**。

---

## Step 1 / 5: Google Cloud プロジェクトを作成

1. [https://console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate) を開く
2. **プロジェクト名**: 任意（例: `Drive to Explorer`）
3. **場所**: 「組織なし」（個人アカウントの場合自動でこうなる）
4. **「作成」** をクリック
5. 右上の通知で「プロジェクトが作成されました」が出るのを待つ
6. 上部のプロジェクト選択ドロップダウンが新規プロジェクトになっているか確認

---

## Step 2 / 5: Google Drive API を有効化

1. [https://console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com) を開く
2. **プロジェクト選択**が新規プロジェクトになっていることを確認（右上）
3. **「有効にする」** ボタンをクリック
4. 「Google Drive API は有効になりました」と出れば OK

---

## Step 3 / 5: OAuth 同意画面を構成

1. [https://console.cloud.google.com/apis/credentials/consent](https://console.cloud.google.com/apis/credentials/consent) を開く

### 3a. User Type 選択

- **「外部」** を選択 → 「作成」

> **注**: 個人 Gmail アカウントの場合「外部」しか選べません。これで OK です。

### 3b. アプリ情報

| 項目 | 値 |
|---|---|
| アプリ名 | `Drive to Explorer`（任意） |
| ユーザーサポートメール | 自分の Gmail アドレス |
| アプリのロゴ | （スキップ可） |
| アプリのドメイン | （スキップ可） |
| デベロッパーの連絡先 | 自分の Gmail アドレス |

→ **「保存して次へ」**

### 3c. スコープ

1. **「スコープを追加または削除」** をクリック
2. フィルタ欄に `drive.metadata.readonly` を貼り付け
3. 表示された `https://www.googleapis.com/auth/drive.metadata.readonly` をチェック
4. **「更新」** → **「保存して次へ」**

### 3d. テストユーザー

1. **「+ ADD USERS」** をクリック
2. **自分の Gmail アドレス** を入力（複数 PC で使う場合は同じ Gmail で OK）
3. **「追加」** → **「保存して次へ」**

> **注**: テストユーザーに追加された Gmail アカウントだけが Drive API を使えます。最大 100 ユーザーまで。個人用なら自分のアカウントだけで十分。

### 3e. 概要

- 内容を確認して **「ダッシュボードに戻る」**

---

## Step 4 / 5: OAuth 2.0 クライアント ID を発行

1. [https://console.cloud.google.com/apis/credentials/oauthclient](https://console.cloud.google.com/apis/credentials/oauthclient) を開く
2. **アプリケーションの種類**: **「ウェブ アプリケーション」**
   - ※「Chrome 拡張機能」ではなく「ウェブ アプリケーション」を選択してください
3. **名前**: `Drive to Explorer Extension`（任意）
4. **「承認済みのリダイレクト URI」** セクション
   - **「+ URI を追加」** をクリック
   - 以下を貼り付け:
     ```
     https://pkiecgchhhhcgnjjgofmlfobbhacdcge.chromiumapp.org/
     ```
5. **「作成」** をクリック
6. ダイアログに表示される **「クライアント ID」** をコピー
   - 形式: `123456789-xxxxxxxxxxxx.apps.googleusercontent.com`
   - **「クライアント シークレット」は不要**（拡張機能側では使わない）

---

## Step 5 / 5: 拡張機能側でクライアント ID を登録

1. 拡張機能のアイコンを右クリック → **「オプション」**
2. **「Drive REST API (OAuth)」** セクション
3. **「OAuth Client ID」** 欄にコピーした ID を貼り付け
4. **「Client ID 保存」**
5. **「サインイン」** をクリック
   - 別タブで Google サインイン画面が開く
   - 「テストユーザー」として追加した Gmail でサインイン
   - 「このアプリは確認されていません」と出るが、**「詳細」 → 「Drive to Explorer に移動（安全ではないページ）」** で進む
     - これは「Google 審査を通っていないアプリ」の警告。自分が作ったアプリなので問題なし
   - 権限承認画面で **「許可」**
6. オプション画面に戻り **「✓ サインイン済み」** と表示されれば完了

---

## 完了後の挙動

- **フォルダ画面**: 従来の DOM 解析より高速・確実に解決（同名フォルダ誤爆なし）
- **ファイル単体 URL** (`/file/d/<id>/view`): 完全対応。同名ファイルがあれば選択、無ければ親フォルダ起動
- **`パスを表示`ボタンのフラッシュ無し**: API 直接呼び出しなので Drive UI を一切触らない
- **Explorer 右クリック「Drive で開く」** (逆方向機能) も動作

---

## トラブルシューティング

### 「アクセス権がありません」エラー

- OAuth 同意画面のテストユーザーに自分の Gmail が追加されているか確認 (Step 3d)
- スコープが `drive.metadata.readonly` になっているか確認 (Step 3c)

### 「リダイレクト URI 不一致」エラー

- Step 4 で追加した URI が `https://pkiecgchhhhcgnjjgofmlfobbhacdcge.chromiumapp.org/` ちょうどか確認
  - 末尾の `/` を忘れがち
  - 拡張機能 ID 部分は配布版で固定なので変更不要

### サインインしても「Client ID 未設定」と出る

- Client ID 保存ボタンを押し忘れていないか確認
- ブラウザを再起動して再試行

### 別 PC でも同じクライアント ID を使えますか

**はい**。`manifest.key` により拡張機能 ID が固定化されているので、複数 PC で同じ OAuth Client ID が使えます。各 PC でオプション画面に同じ ID を貼り付け、それぞれサインインすれば OK。

---

## アンインストール

OAuth 自体を解除したい場合:

1. 拡張機能オプション画面で **「サインアウト」**
2. [Google アカウントのアプリ管理](https://myaccount.google.com/permissions) で「Drive to Explorer」のアクセスを削除
3. （任意）GCP プロジェクトごと削除する場合は [https://console.cloud.google.com/cloud-resource-manager](https://console.cloud.google.com/cloud-resource-manager) でプロジェクトを「シャットダウン」

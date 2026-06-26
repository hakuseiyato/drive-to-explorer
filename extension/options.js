const $ = (id) => document.getElementById(id);
const status = $("status");

async function load() {
  // localRoots (新形式: array) / localRoot (旧形式: string) 両対応で読み込み
  const obj = await chrome.storage.sync.get(["localRoots", "localRoot"]);
  let roots = [];
  if (Array.isArray(obj.localRoots) && obj.localRoots.length) {
    roots = obj.localRoots;
  } else if (obj.localRoot) {
    roots = [obj.localRoot];
  }
  $("localRoots").value = roots.join("\n");
}

function normalize(p) {
  let v = (p || "").trim();
  if (!v) return "";
  // 末尾の \ や / を除去
  v = v.replace(/[\\/]+$/, "");
  // ドライブレターのみ (例: "M:") の場合は "M:\" に
  if (/^[A-Za-z]:$/.test(v)) v += "\\";
  return v;
}

// textarea の値を行ごとにパース→正規化→重複排除した配列にする
function parseRoots(textareaValue) {
  const lines = String(textareaValue || "")
    .split(/\r?\n/)
    .map((s) => normalize(s))
    .filter((s) => s.length > 0);
  // 重複排除 (大文字小文字無視)
  const seen = new Set();
  const result = [];
  for (const v of lines) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(v);
  }
  return result;
}

function isValidRoot(v) {
  return /^[A-Za-z]:[\\/]/.test(v);
}

$("saveBtn").addEventListener("click", async () => {
  const roots = parseRoots($("localRoots").value);
  if (roots.length === 0) {
    status.innerHTML = '<span class="err">少なくとも 1 つのルートパスを入力してください。</span>';
    return;
  }
  const invalid = roots.filter((v) => !isValidRoot(v));
  if (invalid.length) {
    status.innerHTML =
      '<span class="err">ドライブレター始まりの絶対パスを指定してください (例: <code>M:\\</code>)。<br>不正な行: ' +
      invalid.map((v) => `<code>${v}</code>`).join(", ") +
      "</span>";
    return;
  }
  // 新形式 + 旧形式 (互換) を両方保存
  await chrome.storage.sync.set({ localRoots: roots, localRoot: roots[0] });
  await chrome.storage.sync.remove("mappings");
  $("localRoots").value = roots.join("\n");
  status.innerHTML =
    '<span class="ok">保存しました: ' +
    roots.map((v) => `<code>${v}</code>`).join(" / ") +
    "</span>";
});

$("testBtn").addEventListener("click", async () => {
  const roots = parseRoots($("localRoots").value);
  if (roots.length === 0) {
    status.innerHTML = '<span class="err">ルートパスを入力してください。</span>';
    return;
  }
  const invalid = roots.filter((v) => !isValidRoot(v));
  if (invalid.length) {
    status.innerHTML =
      '<span class="err">不正な行があります (ドライブレター始まりが必要): ' +
      invalid.map((v) => `<code>${v}</code>`).join(", ") +
      "</span>";
    return;
  }
  const resp = await chrome.runtime.sendMessage({
    type: "hostRequest",
    payload: { action: "exists_many", paths: roots },
  });
  if (!resp || !resp.ok) {
    status.innerHTML = `<span class="err">ホストエラー: ${(resp && resp.error) || "通信失敗"}</span>`;
    return;
  }
  const results = resp.results || [];
  const lines = results.map((r) => {
    if (r.exists) return `<span class="ok">✓ ${r.path}</span>`;
    if (r.error) return `<span class="err">✗ ${r.path} — ${r.error}</span>`;
    return `<span class="err">✗ ${r.path}</span>`;
  });
  status.innerHTML = lines.join("<br>");
});

load();

// =====================================================================
// 拡張機能 ID 表示 / コピー
// =====================================================================
$("extensionId").value = chrome.runtime.id;
$("copyIdBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(chrome.runtime.id);
    $("installStatus").innerHTML =
      '<span class="ok">✓ ID をコピーしました。install.bat を起動して貼り付けてください。</span>';
  } catch (e) {
    // 権限フォールバック
    $("extensionId").select();
    document.execCommand("copy");
    $("installStatus").innerHTML =
      '<span class="ok">✓ ID をコピーしました (フォールバック)。</span>';
  }
});

// =====================================================================
// OAuth セクション
// =====================================================================
const oauthStatus = $("oauthStatus");

async function refreshOAuthUi() {
  const r = await chrome.runtime.sendMessage({ type: "apiGetRedirectUri" });
  if (r && r.redirectUri) $("redirectUri").value = r.redirectUri;

  const st = await chrome.runtime.sendMessage({ type: "apiStatus" });
  if (!st || !st.ok) return;
  if (!st.hasClientId) {
    oauthStatus.innerHTML =
      '<span class="muted">Client ID 未設定 — DOM 解析にフォールバックします。</span>';
  } else if (st.isDefaultClientId && !st.signedIn) {
    oauthStatus.innerHTML =
      '<span class="muted">配布版の既定 Client ID を使用します。<strong>「サインイン」</strong>を押して利用開始してください。</span>';
  } else if (!st.signedIn) {
    oauthStatus.innerHTML =
      '<span class="muted">独自 Client ID 設定済み。サインインしていないため、必要時に対話認可が走ります。</span>';
  } else if (st.isDefaultClientId) {
    oauthStatus.innerHTML =
      '<span class="ok">✓ サインイン済み (既定 Client ID 使用) — API 経由でパス解決します。</span>';
  } else {
    oauthStatus.innerHTML =
      '<span class="ok">✓ サインイン済み (独自 Client ID 使用) — API 経由でパス解決します。</span>';
  }
}

async function loadClientId() {
  const { oauthClientId = "" } = await chrome.storage.sync.get("oauthClientId");
  $("oauthClientId").value = oauthClientId;
}

$("oauthSaveBtn").addEventListener("click", async () => {
  const id = $("oauthClientId").value.trim();
  const r = await chrome.runtime.sendMessage({
    type: "apiSetClientId",
    clientId: id,
  });
  if (r && r.ok) {
    oauthStatus.innerHTML = '<span class="ok">Client ID を保存しました。</span>';
    refreshOAuthUi();
  } else {
    oauthStatus.innerHTML = '<span class="err">保存失敗</span>';
  }
});

$("oauthSignInBtn").addEventListener("click", async () => {
  oauthStatus.textContent = "認可中…";
  const r = await chrome.runtime.sendMessage({ type: "apiSignIn" });
  if (r && r.ok) {
    oauthStatus.innerHTML = '<span class="ok">✓ サインイン成功。</span>';
    refreshOAuthUi();
  } else {
    oauthStatus.innerHTML = `<span class="err">サインイン失敗: ${(r && r.error) || ""}</span>`;
  }
});

$("oauthSignOutBtn").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "apiSignOut" });
  if (r && r.ok) {
    oauthStatus.innerHTML = '<span class="muted">サインアウトしました。</span>';
    refreshOAuthUi();
  } else {
    oauthStatus.innerHTML = `<span class="err">サインアウト失敗: ${(r && r.error) || ""}</span>`;
  }
});

loadClientId();
refreshOAuthUi();

// =====================================================================
// アップデート確認
// =====================================================================
const updateStatusEl = $("updateStatus");
const versionLabel = $("versionLabel");

function escUpd(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderUpdateInfo(info) {
  if (!info || !info.currentVersion) return;
  versionLabel.textContent = "v" + info.currentVersion;
  if (info.ok === false) {
    updateStatusEl.innerHTML = `<span class="err">アップデート確認失敗: ${escUpd(info.error || "")}</span>`;
    return;
  }
  if (info.isOutdated) {
    updateStatusEl.innerHTML =
      `<span class="ok">↑ 新バージョン <strong>v${escUpd(info.latestVersion)}</strong> が利用可能です。</span>` +
      ` <a href="${escUpd(info.releaseUrl || "")}" target="_blank">リリースを開く</a>` +
      `<br><span class="muted">上の <strong>「今すぐ更新」</strong> ボタンでワンクリック更新できます（bat 実行・再起動不要）。</span>`;
  } else if (info.latestVersion) {
    updateStatusEl.innerHTML =
      `<span class="muted">✓ 最新です (v${escUpd(info.latestVersion)})</span>`;
  } else {
    updateStatusEl.innerHTML = "";
  }
}

async function loadUpdateInfo() {
  const r = await chrome.runtime.sendMessage({ type: "getCachedUpdateInfo" });
  if (r && r.ok) renderUpdateInfo({ ...r, ok: true });
  else if (r && r.currentVersion) versionLabel.textContent = "v" + r.currentVersion;
}

$("checkUpdateBtn").addEventListener("click", async () => {
  $("checkUpdateBtn").disabled = true;
  updateStatusEl.innerHTML = '<span class="muted">確認中…</span>';
  const r = await chrome.runtime.sendMessage({ type: "checkUpdate" });
  $("checkUpdateBtn").disabled = false;
  renderUpdateInfo(r);
});

loadUpdateInfo();

// ---------------------------------------------------------------------
// ワンクリック更新の適用（Native Host + updater.ps1 が実体）
//   DL → 展開 → ファイル入替 を Host 側で実行し、進捗をポーリング表示。
//   done を検知したら chrome.runtime.reload() で新バージョンを反映。
//   ブラウザ再起動・コピペ・bat 実行はいずれも不要。
// ---------------------------------------------------------------------
const applyUpdateBtn = $("applyUpdateBtn");
const updateProgress = $("updateProgress");
const updateProgressFill = $("updateProgressFill");

const UPDATE_STATE_LABEL = {
  starting: "更新を開始しています…",
  downloading: "最新版をダウンロード中…",
  extracting: "展開中…",
  waiting: "準備中（ホスト終了待ち）…",
  swapping: "ファイルを入れ替え中…",
  done: "更新完了！",
  error: "更新エラー",
  unknown: "状態を確認中…",
};

// 各状態のおおよその進捗率（バー表示用）
const UPDATE_STATE_PCT = {
  starting: 8,
  downloading: 30,
  extracting: 60,
  waiting: 72,
  swapping: 88,
  done: 100,
};

function showProgress(pct, variant) {
  if (!updateProgress) return;
  updateProgress.classList.add("active");
  updateProgress.classList.toggle("err", variant === "err");
  updateProgress.classList.toggle("done", variant === "done");
  if (typeof pct === "number") updateProgressFill.style.width = pct + "%";
}

function hideProgress() {
  if (!updateProgress) return;
  updateProgress.classList.remove("active", "err", "done");
  updateProgressFill.style.width = "0%";
}

let updateApplying = false;

async function pollUpdateStatus() {
  const maxTries = 60; // 2s 間隔 × 60 = 最大 2 分
  for (let i = 0; i < maxTries; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: "updateStatus" });
    } catch (_) {
      r = null;
    }
    // 入替中はホスト exe が一時的にロックされ応答が取れないことがある。
    // その間は「適用中」とみなしてポーリングを継続する。
    if (!r || r.ok === false || !r.state || r.state === "unknown") {
      updateStatusEl.innerHTML = '<span class="muted">適用中…</span>';
      continue;
    }
    if (r.state === "error") {
      showProgress(100, "err");
      updateStatusEl.innerHTML =
        `<span class="err">更新に失敗しました: ${escUpd(r.error || "")}</span>` +
        `<br><span class="muted">フォールバック: インストール先フォルダの <code>update.bat</code> を実行してください。</span>`;
      applyUpdateBtn.disabled = false;
      $("checkUpdateBtn").disabled = false;
      updateApplying = false;
      return;
    }
    if (r.state === "done") {
      showProgress(100, "done");
      updateStatusEl.innerHTML =
        `<span class="ok">✓ v${escUpd(r.version || "")} に更新しました。拡張を再読み込みします…</span>`;
      setTimeout(() => {
        try { chrome.runtime.reload(); } catch (_) {}
      }, 1500);
      updateApplying = false;
      return;
    }
    const label = UPDATE_STATE_LABEL[r.state] || r.state;
    const pct = UPDATE_STATE_PCT[r.state];
    if (typeof pct === "number") showProgress(pct);
    updateStatusEl.innerHTML = `<span class="muted">${escUpd(label)}</span>`;
  }
  showProgress(100, "err");
  updateStatusEl.innerHTML =
    '<span class="err">更新がタイムアウトしました。</span>' +
    '<br><span class="muted">フォールバック: <code>update.bat</code> を実行してください。</span>';
  applyUpdateBtn.disabled = false;
  $("checkUpdateBtn").disabled = false;
  updateApplying = false;
}

if (applyUpdateBtn) {
  applyUpdateBtn.addEventListener("click", async () => {
    if (updateApplying) return;
    const ok = confirm(
      "最新版をダウンロードして自動適用します。\n" +
      "完了後に拡張が自動で再読み込みされます（ブラウザ再起動・bat 実行は不要）。\n\n" +
      "実行しますか？"
    );
    if (!ok) return;

    updateApplying = true;
    applyUpdateBtn.disabled = true;
    $("checkUpdateBtn").disabled = true;
    showProgress(8);
    updateStatusEl.innerHTML = '<span class="muted">更新を開始しています…</span>';

    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: "applyUpdate" });
    } catch (e) {
      r = { ok: false, error: String(e) };
    }

    if (!r || r.ok === false || !r.updating) {
      const err = (r && r.error) || "Native Host から応答がありません";
      showProgress(100, "err");
      updateStatusEl.innerHTML =
        `<span class="err">更新を開始できませんでした: ${escUpd(err)}</span>` +
        `<br><span class="muted">Native Host が未登録の可能性があります。<code>install.bat</code> を実行してください。</span>`;
      applyUpdateBtn.disabled = false;
      $("checkUpdateBtn").disabled = false;
      updateApplying = false;
      return;
    }

    pollUpdateStatus();
  });
}

// =====================================================================
// API モードテスト
// =====================================================================
const apiTestStatus = $("apiTestStatus");

function escHtmlSimple(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

$("apiTestBtn").addEventListener("click", async () => {
  $("apiTestBtn").disabled = true;
  apiTestStatus.innerHTML = '<span class="muted">テスト中…</span>';

  const r = await chrome.runtime.sendMessage({ type: "apiTest" });
  $("apiTestBtn").disabled = false;

  if (!r) {
    apiTestStatus.innerHTML = '<span class="err">背景プロセスから応答がありません</span>';
    return;
  }

  if (r.ok && r.breadcrumbs) {
    const path = r.breadcrumbs.map(escHtmlSimple).join(" / ");
    const refStr = r.driveRef
      ? `${r.driveRef.type}:${escHtmlSimple(r.driveRef.id)}`
      : "";
    apiTestStatus.innerHTML =
      `<span class="ok">✓ API 解決成功</span><br>` +
      `<span class="muted">URL: ${escHtmlSimple(r.tabUrl || "")}</span><br>` +
      `<span class="muted">対象: ${refStr}</span><br>` +
      `<div style="margin-top:6px;padding:6px 8px;background:#fff;border:1px solid #ddd;border-radius:3px;font-family:Consolas,monospace;font-size:12px;word-break:break-all;">${path}</div>`;
    return;
  }

  // エラー時: code と詳細を表示
  const code = r.code || "?";
  const codeHints = {
    "NO_TAB": "アクティブタブが取れません。Drive タブを開いた状態でテストしてください。",
    "NO_DRIVE_REF": "現在のタブが Drive のフォルダ／ファイル URL ではありません。",
    "NO_CLIENT_ID": "OAuth Client ID が未設定です (空文字)。配布版なら自動的に既定値が使われるはずなので、storage 異常の可能性。",
    "AUTH_FAILED": "認可フロー失敗。「サインイン」ボタンを押してやり直してください。",
    "NO_INTERACTIVE_TOKEN": "非対話モードでトークン取得失敗。「サインイン」ボタンを押してください (Drive ページからの呼び出しは user activation 不足で interactive が動かないため、options 画面 / popup から明示的にサインインが必要)。",
    "EXCEPTION": "予期しない例外。デバッグログを ON にして DevTools コンソールを確認してください。",
  };
  const hint = codeHints[code] || "";
  const errMsg = escHtmlSimple(r.error || "不明なエラー");
  apiTestStatus.innerHTML =
    `<span class="err">✗ API 解決失敗 (code: ${escHtmlSimple(code)})</span><br>` +
    `<span class="muted">${errMsg}</span>` +
    (hint ? `<br><span class="muted" style="display:inline-block;margin-top:4px;">→ ${escHtmlSimple(hint)}</span>` : "") +
    (r.tabUrl ? `<br><span class="muted">URL: ${escHtmlSimple(r.tabUrl)}</span>` : "");
});

// =====================================================================
// デバッグトグル
// =====================================================================
async function loadDebugFlag() {
  const { dteDebug = false } = await chrome.storage.local.get("dteDebug");
  $("debugToggle").checked = !!dteDebug;
}
$("debugToggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ dteDebug: !!e.target.checked });
});
loadDebugFlag();

// =====================================================================
// OAuth セットアップウィザード
// =====================================================================
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const WIZARD_STEPS = [
  {
    title: "OAuth セットアップウィザード",
    body: () => `
      <p>
        Google Cloud Console で <strong>OAuth クライアント ID</strong> を作成し、
        Drive REST API 経由でフォルダ階層を取得できるようにします。
      </p>
      <p style="background:#fffbe6; border-left:4px solid #faad14; padding:8px 12px; margin:12px 0; border-radius:4px;">
        所要時間 約 5 分。各ステップで「Cloud Console を開く」を押すと正しいページがタブで開きます。
      </p>
      <p>
        準備するもの: Google アカウント (Drive を使っているもの)<br>
        最後に <strong>クライアント ID</strong> を本ウィザードに貼り付けて完了します。
      </p>
    `,
    actions: [{ label: "開始", primary: true, next: true }],
  },
  {
    title: "Step 1 / 5: Google Cloud プロジェクトを作成",
    body: () => `
      <p>「Cloud Console を開く」を押すと新規プロジェクト作成ページが開きます。</p>
      <ol>
        <li>プロジェクト名: <code>Drive to Explorer</code> (任意)</li>
        <li>場所: 「組織なし」 (個人 Google アカウントの場合自動)</li>
        <li>「<strong>作成</strong>」をクリック</li>
        <li>作成完了通知でプロジェクトに切り替わるのを確認</li>
      </ol>
    `,
    actions: [
      { label: "Cloud Console を開く", url: "https://console.cloud.google.com/projectcreate" },
      { label: "完了 → 次へ", primary: true, next: true },
    ],
  },
  {
    title: "Step 2 / 5: Google Drive API を有効化",
    body: () => `
      <p>API ライブラリで Drive API を有効にします。</p>
      <ol>
        <li>「Cloud Console を開く」(Drive API ページが直接開きます)</li>
        <li>右上のプロジェクト選択が <code>Drive to Explorer</code> になっているか確認</li>
        <li>「<strong>有効にする</strong>」をクリック</li>
      </ol>
    `,
    actions: [
      { label: "Cloud Console を開く", url: "https://console.cloud.google.com/apis/library/drive.googleapis.com" },
      { label: "完了 → 次へ", primary: true, next: true },
    ],
  },
  {
    title: "Step 3 / 5: OAuth 同意画面を構成",
    body: () => `
      <p>同意画面でアプリ情報・スコープ・テストユーザーを設定します。</p>
      <ol>
        <li>User Type: <strong>外部</strong> → 作成</li>
        <li>アプリ名: <code>Drive to Explorer</code>、サポートメール / デベロッパー連絡先に自分の Gmail を入力 → 保存して次へ</li>
        <li>スコープ追加: 「<strong>スコープを追加または削除</strong>」 →
          検索欄に下のスコープを貼って ON → 更新 → 保存して次へ
          <div style="margin:6px 0;">
            <code style="display:inline-block; padding:4px 8px; background:#f4f4f4; border-radius:4px;">drive.metadata.readonly</code>
            <button id="copyScope" style="margin-left:6px;">コピー</button>
          </div>
        </li>
        <li>テストユーザー: 「<strong>ADD USERS</strong>」で <strong>自分の Gmail</strong> を追加 → 保存して次へ</li>
        <li>概要画面 → 「ダッシュボードに戻る」</li>
      </ol>
    `,
    onShow: () => {
      // スコープコピーボタン
      setTimeout(() => {
        const b = document.getElementById("copyScope");
        if (b) {
          b.addEventListener("click", async () => {
            await navigator.clipboard.writeText("https://www.googleapis.com/auth/drive.metadata.readonly");
            wizardSetStatus("スコープをコピーしました", "ok");
          });
        }
      }, 0);
    },
    actions: [
      { label: "Cloud Console を開く", url: "https://console.cloud.google.com/apis/credentials/consent" },
      { label: "完了 → 次へ", primary: true, next: true },
    ],
  },
  {
    title: "Step 4 / 5: OAuth クライアント ID を作成",
    body: (ctx) => `
      <p>「Cloud Console を開く」を押すと作成ページが開きます。<br>
        同時に <strong>リダイレクト URI</strong> をクリップボードに自動コピーします。</p>
      <ol>
        <li>アプリケーションの種類: <strong>ウェブ アプリケーション</strong></li>
        <li>名前: <code>Drive to Explorer Extension</code> (任意)</li>
        <li>「承認済みのリダイレクト URI」 → 「+ URI を追加」 → <strong>クリップボードから貼り付け</strong>:
          <div style="background:#f4f4f4; padding:8px; border-radius:4px; margin:6px 0; font-family:monospace; font-size:12px; word-break:break-all;">
            ${escHtml(ctx.redirectUri || "")}
          </div>
        </li>
        <li>「作成」をクリック</li>
        <li>表示された <strong>クライアント ID</strong> をコピー (次のステップで貼り付け)</li>
      </ol>
    `,
    onShow: async (ctx) => {
      // リダイレクト URI を自動でクリップボードにコピー
      try {
        await navigator.clipboard.writeText(ctx.redirectUri);
        wizardSetStatus("リダイレクト URI をクリップボードにコピーしました", "ok");
      } catch (_) {
        wizardSetStatus("(クリップボードへの自動コピーに失敗 — 上の枠から手動コピーしてください)", "muted");
      }
    },
    actions: [
      { label: "Cloud Console を開く", url: "https://console.cloud.google.com/apis/credentials/oauthclient" },
      { label: "リダイレクト URI を再コピー", action: "copyRedirect" },
      { label: "完了 → 次へ", primary: true, next: true },
    ],
  },
  {
    title: "Step 5 / 5: クライアント ID を貼り付け & サインイン",
    body: () => `
      <p>コピーしたクライアント ID を下に貼り付けてください。形式は <code>...apps.googleusercontent.com</code></p>
      <input type="text" id="wizClientId" placeholder="xxxxxxxxxxxx.apps.googleusercontent.com"
        style="width:100%; box-sizing:border-box; padding:6px 8px; font:inherit; border:1px solid #ccc; border-radius:4px;" autocomplete="off">
    `,
    actions: [
      { label: "保存してサインイン", primary: true, action: "saveAndSignIn" },
    ],
  },
  {
    title: "✓ 完了",
    body: () => `
      <p style="color:#1a7f37; font-weight:600;">セットアップが完了しました。</p>
      <p>
        以後、Drive Web で「エクスプローラーで開く」を実行すると Drive REST API 経由で
        フォルダ階層が解決されます。<br>
        パス popup フラッシュ無しで動作するようになります。
      </p>
      <p>
        Explorer 右クリック「Drive で開く」(逆方向) もこの OAuth で動作します。
      </p>
    `,
    actions: [
      { label: "閉じる", primary: true, action: "close" },
    ],
  },
];

let wizardCurrentStep = 0;
const wizardCtx = {};

function wizardSetStatus(msg, kind) {
  const s = document.getElementById("wizardStatus");
  if (!s) return;
  const cls = kind === "ok" ? "ok" : kind === "err" ? "err" : "muted";
  s.innerHTML = `<span class="${cls}">${escHtml(msg)}</span>`;
}

async function openWizard() {
  // リダイレクト URI を取得して context に保持
  const r = await chrome.runtime.sendMessage({ type: "apiGetRedirectUri" });
  wizardCtx.redirectUri = (r && r.redirectUri) || "";
  // 既存 Client ID があれば最終ステップでフィルしておく
  const { oauthClientId = "" } = await chrome.storage.sync.get("oauthClientId");
  wizardCtx.existingClientId = oauthClientId;

  wizardCurrentStep = 0;
  renderWizardStep();
  document.getElementById("wizardModal").style.display = "flex";
}

function closeWizard() {
  document.getElementById("wizardModal").style.display = "none";
  wizardSetStatus("", "");
  refreshOAuthUi();
}

function renderWizardStep() {
  const step = WIZARD_STEPS[wizardCurrentStep];
  document.getElementById("wizardStepNum").textContent =
    `${wizardCurrentStep === 0 ? "" : ""}` + (step.title || "");
  // 上部の小さい counter (Step n/5 を含むタイトルからは外して)
  document.getElementById("wizardStepNum").textContent =
    wizardCurrentStep === 0 || wizardCurrentStep === WIZARD_STEPS.length - 1
      ? ""
      : `${wizardCurrentStep} / ${WIZARD_STEPS.length - 2}`;
  document.getElementById("wizardTitle").textContent = step.title;
  document.getElementById("wizardBody").innerHTML =
    typeof step.body === "function" ? step.body(wizardCtx) : step.body;
  wizardSetStatus("", "");

  // アクションボタン
  const actionsEl = document.getElementById("wizardActions");
  actionsEl.innerHTML = "";
  for (const a of step.actions || []) {
    const b = document.createElement("button");
    b.textContent = a.label;
    if (a.primary) b.className = "primary";
    b.addEventListener("click", () => handleWizardAction(a));
    actionsEl.appendChild(b);
  }
  // 戻るボタン (任意)
  if (wizardCurrentStep > 0 && wizardCurrentStep < WIZARD_STEPS.length - 1) {
    const back = document.createElement("button");
    back.textContent = "← 戻る";
    back.style.marginRight = "auto";
    back.addEventListener("click", () => {
      wizardCurrentStep = Math.max(0, wizardCurrentStep - 1);
      renderWizardStep();
    });
    actionsEl.insertBefore(back, actionsEl.firstChild);
  }

  // onShow フック
  if (step.onShow) {
    try {
      step.onShow(wizardCtx);
    } catch (e) {
      console.error("wizard onShow error", e);
    }
  }
}

async function handleWizardAction(a) {
  if (a.url) {
    try {
      window.open(a.url, "_blank", "noopener");
    } catch (_) {}
    return;
  }
  if (a.action === "copyRedirect") {
    try {
      await navigator.clipboard.writeText(wizardCtx.redirectUri || "");
      wizardSetStatus("リダイレクト URI をコピーしました", "ok");
    } catch (e) {
      wizardSetStatus("コピー失敗: " + e.message, "err");
    }
    return;
  }
  if (a.action === "saveAndSignIn") {
    const input = document.getElementById("wizClientId");
    const cid = (input && input.value || "").trim();
    if (!cid) {
      wizardSetStatus("クライアント ID を入力してください", "err");
      return;
    }
    if (!/\.apps\.googleusercontent\.com$/.test(cid)) {
      wizardSetStatus("形式が違います (...apps.googleusercontent.com で終わる文字列)", "err");
      return;
    }
    wizardSetStatus("保存中…", "muted");
    const r1 = await chrome.runtime.sendMessage({ type: "apiSetClientId", clientId: cid });
    if (!r1 || !r1.ok) {
      wizardSetStatus("保存失敗", "err");
      return;
    }
    wizardSetStatus("認可中… (ブラウザが Google サインイン画面を表示します)", "muted");
    const r2 = await chrome.runtime.sendMessage({ type: "apiSignIn" });
    if (!r2 || !r2.ok) {
      wizardSetStatus("サインイン失敗: " + ((r2 && r2.error) || ""), "err");
      return;
    }
    // 上部のフォーム値も同期
    document.getElementById("oauthClientId").value = cid;
    wizardCurrentStep = WIZARD_STEPS.length - 1;
    renderWizardStep();
    return;
  }
  if (a.action === "close") {
    closeWizard();
    return;
  }
  if (a.next) {
    wizardCurrentStep = Math.min(WIZARD_STEPS.length - 1, wizardCurrentStep + 1);
    renderWizardStep();
    return;
  }
}

document.getElementById("wizardBtn").addEventListener("click", openWizard);
document.getElementById("wizardClose").addEventListener("click", closeWizard);
document.getElementById("wizardModal").addEventListener("click", (e) => {
  if (e.target.id === "wizardModal") closeWizard();
});

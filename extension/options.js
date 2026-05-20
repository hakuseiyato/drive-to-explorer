const $ = (id) => document.getElementById(id);
const status = $("status");

async function load() {
  // デフォルト値は持たない (環境固有のドライブレターをコードから除去)
  const { localRoot = "" } = await chrome.storage.sync.get("localRoot");
  $("localRoot").value = localRoot;
}

function normalize(p) {
  let v = (p || "").trim();
  if (!v) return "";
  // 末尾の \ や / を除去（最後にバックスラッシュのみ付与）
  v = v.replace(/[\\/]+$/, "");
  // ドライブレターのみ (例: "M:") の場合は "M:\" に
  if (/^[A-Za-z]:$/.test(v)) v += "\\";
  return v;
}

$("saveBtn").addEventListener("click", async () => {
  const v = normalize($("localRoot").value);
  if (!v) {
    status.innerHTML = '<span class="err">ルートパスを入力してください。</span>';
    return;
  }
  if (!/^[A-Za-z]:[\\/]/.test(v)) {
    status.innerHTML = '<span class="err">ドライブレター始まりの絶対パスを指定してください (例: M:\\)。</span>';
    return;
  }
  await chrome.storage.sync.set({ localRoot: v });
  // 旧形式のマッピングは破棄
  await chrome.storage.sync.remove("mappings");
  $("localRoot").value = v;
  status.innerHTML = `<span class="ok">保存しました: ${v}</span>`;
});

$("testBtn").addEventListener("click", async () => {
  const v = normalize($("localRoot").value);
  if (!v) {
    status.innerHTML = '<span class="err">ルートパスを入力してください。</span>';
    return;
  }
  const resp = await chrome.runtime.sendMessage({
    type: "hostRequest",
    payload: { action: "exists", path: v },
  });
  if (!resp || !resp.ok) {
    status.innerHTML = `<span class="err">ホストエラー: ${(resp && resp.error) || "通信失敗"}</span>`;
    return;
  }
  if (resp.exists) {
    status.innerHTML = `<span class="ok">✓ ${v} は存在します。</span>`;
  } else {
    status.innerHTML = `<span class="err">✗ ${v} は見つかりません。Drive for desktop のドライブレターを確認してください。</span>`;
  }
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
  } else if (!st.signedIn) {
    oauthStatus.innerHTML =
      '<span class="muted">Client ID 設定済み。サインインしていないため、必要時に対話認可が走ります。</span>';
  } else {
    oauthStatus.innerHTML =
      '<span class="ok">✓ サインイン済み — API 経由でパス解決します。</span>';
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

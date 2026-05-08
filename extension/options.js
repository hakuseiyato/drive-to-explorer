const $ = (id) => document.getElementById(id);
const status = $("status");

async function load() {
  const { localRoot = "M:\\" } = await chrome.storage.sync.get("localRoot");
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

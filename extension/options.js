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

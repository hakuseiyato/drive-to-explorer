const $ = (id) => document.getElementById(id);

// content script に user activation 付きでパス取得を依頼する
// (chrome.scripting.executeScript は popup の click ハンドラ内で呼ばれた場合
//  user activation を伝播するため、Drive の jsaction が反応する)
async function fetchFullPathWithActivation() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return null;

  // 注入関数: ページ内 (content script と別 isolated world) で実行される。
  // 既存の content script に CustomEvent で伝達する。
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return new Promise((resolve) => {
        const onResult = (ev) => {
          window.removeEventListener("__DTE_PATH_RESULT__", onResult);
          resolve(ev.detail || null);
        };
        window.addEventListener("__DTE_PATH_RESULT__", onResult);
        // 開始合図 (user activation 付き)
        window.dispatchEvent(new CustomEvent("__DTE_FETCH_PATH__"));
        // タイムアウト (3 秒)
        setTimeout(() => {
          window.removeEventListener("__DTE_PATH_RESULT__", onResult);
          resolve(null);
        }, 3000);
      });
    },
    world: "MAIN",
  });
  return (results && results[0] && results[0].result) || null;
}

async function refresh() {
  const status = $("status");
  // 表示用は軽量な resolvePath (パスを表示クリック無し) を使う
  const resp = await chrome.runtime.sendMessage({ type: "resolvePath", quick: true });
  if (!resp || !resp.ok) {
    $("breadcrumbs").textContent = "―";
    $("localPath").textContent = "―";
    status.innerHTML = '<span class="err">Drive タブで開いてください。</span>';
    $("openBtn").disabled = true;
    return;
  }
  const bc = (resp.breadcrumbs || []).join(" / ") || "―";
  $("breadcrumbs").textContent = bc;
  if (!resp.localRoot) {
    $("localPath").textContent = "―";
    $("openBtn").disabled = true;
    status.innerHTML =
      '<span class="muted">初期設定が未完了です。「設定」からローカルルート (例: I:\\) を登録してください。</span>';
    return;
  }
  $("localPath").textContent = resp.localPath || "―";
  $("openBtn").disabled = false;
  status.innerHTML =
    '<span class="muted">「エクスプローラーで開く」で完全パスを取得します。</span>';
}

$("openBtn").addEventListener("click", async () => {
  const status = $("status");
  $("openBtn").disabled = true;
  status.textContent = "完全パスを取得中…";

  // user activation を伝播するため popup から直接 executeScript で取得
  const full = await fetchFullPathWithActivation();
  if (full && full.breadcrumbs && full.breadcrumbs.length) {
    $("breadcrumbs").textContent = full.breadcrumbs.join(" / ");
    status.textContent = "起動中…";
    const resp = await chrome.runtime.sendMessage({
      type: "openTargetWithBreadcrumbs",
      breadcrumbs: full.breadcrumbs,
    });
    if (resp && resp.ok) {
      window.close();
      return;
    }
    $("openBtn").disabled = false;
    const err = (resp && resp.error) || "不明なエラー";
    status.innerHTML = `<span class="err">起動失敗: ${err}</span>`;
    return;
  }

  // フォールバック: パス取得失敗 → 現状の breadcrumb で開く
  const resp = await chrome.runtime.sendMessage({ type: "openCurrentFolder" });
  if (resp && resp.ok) {
    window.close();
    return;
  }
  $("openBtn").disabled = false;
  const err = (resp && resp.error) || "不明なエラー";
  status.innerHTML = `<span class="err">起動失敗: ${err}<br>右クリックメニューからの起動もお試しください。</span>`;
});

$("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();

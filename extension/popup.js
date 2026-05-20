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
  const rootsCount = (resp.localRoots && resp.localRoots.length) || (resp.localRoot ? 1 : 0);
  if (rootsCount === 0) {
    $("localPath").textContent = "―";
    $("openBtn").disabled = true;
    status.innerHTML =
      '<span class="muted">初期設定が未完了です。「設定」からローカルルート (例: I:\\) を登録してください。</span>';
    return;
  }
  $("localPath").textContent = resp.localPath || "―";
  $("openBtn").disabled = false;
  $("copyBtn").disabled = false;
  if (resp.isFile) {
    $("openBtn").textContent = "エクスプローラーで開く（ファイル選択）";
    status.innerHTML =
      '<span class="muted">ファイル単体URLです。ローカルに同名ファイルがあれば選択、無ければ親フォルダを開きます。</span>';
  } else {
    $("openBtn").textContent = "エクスプローラーで開く";
    status.innerHTML =
      '<span class="muted">クリック時に完全パスを取得します。</span>';
  }
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
    const openResp = await chrome.runtime.sendMessage({
      type: "openTargetWithBreadcrumbs",
      breadcrumbs: full.breadcrumbs,
      driveRef: full.driveRef || null,
      fileName: full.fileName || null,
    });
    if (openResp && openResp.ok) {
      window.close();
      return;
    }
    $("openBtn").disabled = false;
    const err = (openResp && openResp.error) || "不明なエラー";
    status.innerHTML = `<span class="err">起動失敗: ${err}</span>`;
    return;
  }

  // フォールバック: パス取得失敗 → 現状の breadcrumb で開く
  const fallbackResp = await chrome.runtime.sendMessage({ type: "openCurrentFolder" });
  if (fallbackResp && fallbackResp.ok) {
    window.close();
    return;
  }
  $("openBtn").disabled = false;
  const err = (fallbackResp && fallbackResp.error) || "不明なエラー";
  status.innerHTML = `<span class="err">起動失敗: ${err}<br>右クリックメニューからの起動もお試しください。</span>`;
});

$("copyBtn").addEventListener("click", async () => {
  const status = $("status");
  $("copyBtn").disabled = true;
  status.textContent = "完全パスを取得中…";

  const full = await fetchFullPathWithActivation();
  let breadcrumbs = full && full.breadcrumbs && full.breadcrumbs.length
    ? full.breadcrumbs
    : null;

  // フォールバック: 表示用 quick breadcrumbs を使う
  if (!breadcrumbs) {
    const r = await chrome.runtime.sendMessage({ type: "resolvePath", quick: true });
    breadcrumbs = (r && r.breadcrumbs) || [];
  }

  if (!breadcrumbs.length) {
    $("copyBtn").disabled = false;
    status.innerHTML = '<span class="err">Drive 階層を取得できませんでした。</span>';
    return;
  }
  $("breadcrumbs").textContent = breadcrumbs.join(" / ");

  // ファイル単体URLの場合は kind:'file' でパス解決させる
  const isFile = !!(full && full.driveRef && full.driveRef.type === "file");
  const target = isFile
    ? {
        kind: "file",
        name: full.fileName,
        breadcrumbs: breadcrumbs[breadcrumbs.length - 1] === full.fileName
          ? breadcrumbs.slice(0, -1)
          : breadcrumbs,
      }
    : { kind: "current", breadcrumbs };

  const resp = await chrome.runtime.sendMessage({ type: "resolveTargetPath", target });
  if (!resp || !resp.ok || !resp.path) {
    $("copyBtn").disabled = false;
    status.innerHTML = `<span class="err">パス解決失敗: ${(resp && resp.error) || ""}</span>`;
    return;
  }
  $("localPath").textContent = resp.path;
  try {
    await navigator.clipboard.writeText(resp.path);
    const tag = resp.warning ? ` <span class="muted">(${resp.warning})</span>` : "";
    status.innerHTML = `<span class="muted">✓ コピーしました${tag}</span>`;
  } catch (e) {
    status.innerHTML = `<span class="err">コピー失敗: ${e.message}</span>`;
  }
  $("copyBtn").disabled = false;
});

$("optionsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();

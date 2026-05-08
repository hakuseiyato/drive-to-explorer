// Drive to Explorer - service worker
// - コンテキストメニュー登録
// - popup / content / options からのメッセージ受信
// - Native Messaging Host への送信
// - Drive REST API (OAuth) によるパス解決

importScripts("drive_api.js");

const HOST_NAME = "com.yato.drive_to_explorer";
const CONTEXT_MENU_ID = "drive-to-explorer-open";

// ---- Native Messaging --------------------------------------------------

function sendToHost(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, payload, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve(response || { ok: false, error: "empty response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

// ---- 設定読み込み ------------------------------------------------------

async function getLocalRoot() {
  const { localRoot } = await chrome.storage.sync.get("localRoot");
  return localRoot || "";
}

// ---- パス構築 ----------------------------------------------------------

function buildLocalPath(breadcrumbs, localRoot) {
  if (!localRoot) return null;
  const root = localRoot.replace(/[\\/]+$/, "");
  const parts = (breadcrumbs || [])
    .map((s) => (s || "").trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return root;
  return root + "\\" + parts.join("\\");
}

// Drive for Desktop の典型的なディレクトリ構造を試行する候補リスト
// 共有ドライブは「共有ドライブ\」、My Drive は「マイドライブ\」配下にミラーされる
function buildLocalPathCandidates(breadcrumbs, localRoot) {
  if (!localRoot) return [];
  const root = localRoot.replace(/[\\/]+$/, "");
  const parts = (breadcrumbs || [])
    .map((s) => (s || "").trim())
    .filter((s) => s.length > 0);
  const sub = parts.join("\\");
  if (!sub) return [root];
  return [
    // 1. ルート直下にそのまま (ユーザがすでに root を内側に設定済みのケース)
    root + "\\" + sub,
    // 2. 共有ドライブ配下
    root + "\\共有ドライブ\\" + sub,
    root + "\\Shared drives\\" + sub,
    // 3. マイドライブ配下
    root + "\\マイドライブ\\" + sub,
    root + "\\My Drive\\" + sub,
  ];
}

function isHostMissingError(err) {
  if (!err) return false;
  const s = String(err);
  return /native messaging host not found|host not found|host has not been registered/i.test(s);
}

function hostMissingHelp() {
  return (
    "Native Host が登録されていません。以下を実行してください:\n" +
    "1. drive-to-explorer/native-host/manifest.json の allowed_origins に拡張機能IDを設定\n" +
    "2. drive-to-explorer/native-host/install.bat をダブルクリックで実行\n" +
    "3. ブラウザを完全終了してから再起動"
  );
}

function parentPath(p) {
  if (!p) return "";
  return p.replace(/\\[^\\]+\\?$/, "");
}

// ---- 現在の Drive タブから breadcrumb を取得 -------------------------

async function getCurrentBreadcrumbs(tabId, full) {
  return new Promise((resolve) => {
    const type = full ? "getBreadcrumbsFull" : "getBreadcrumbs";
    chrome.tabs.sendMessage(tabId, { type }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(resp || null);
    });
  });
}

// ---- 起動メイン --------------------------------------------------------

async function ensureLocalRoot() {
  const localRoot = await getLocalRoot();
  if (!localRoot) {
    notify(
      "初期設定が必要です",
      "拡張のオプションでローカルルート (例: M:\\) を設定してください。"
    );
    chrome.runtime.openOptionsPage();
    return null;
  }
  return localRoot;
}

async function openCurrentFolder(tab) {
  if (!tab || !tab.id) {
    const msg = "アクティブな Drive タブが見つかりません。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  // 実際にパスを開く時は完全な breadcrumb (パスを表示 popup 経由) を取る
  const info = await getCurrentBreadcrumbs(tab.id, true);
  if (!info || !info.breadcrumbs || info.breadcrumbs.length === 0) {
    const msg = "Drive のフォルダ階層を取得できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  return await runOpen({
    breadcrumbs: info.breadcrumbs,
    kind: "current",
  });
}

async function openTarget(target) {
  if (!target) {
    const msg = "対象が取得できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  return await runOpen(target);
}

async function runOpen(target) {
  const breadcrumbs = target.breadcrumbs || [];
  if (breadcrumbs.length === 0) {
    const msg = "Drive のフォルダ階層を取得できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  const localRoot = await ensureLocalRoot();
  if (!localRoot) return { ok: false, error: "ローカルルート未設定" };

  // Drive for Desktop の構造に応じて複数候補を試行する
  const baseCandidates = buildLocalPathCandidates(breadcrumbs, localRoot);
  if (baseCandidates.length === 0) {
    const msg = "ローカルパスを構築できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }

  // 行選択がある場合の最終パスを生成する関数
  const buildFinal = (base) => {
    if (target.kind === "folder" && target.name) return base + "\\" + target.name;
    if (target.kind === "file" && target.name) return base + "\\" + target.name;
    return base;
  };
  const action = target.kind === "file" ? "select" : "open";

  // 存在する候補を探す
  let foundPath = null;
  let firstHostError = null;
  const triedPaths = [];
  for (const base of baseCandidates) {
    const candidate = buildFinal(base);
    triedPaths.push(candidate);
    const existResp = await sendToHost({ action: "exists", path: candidate });
    if (!existResp || !existResp.ok) {
      firstHostError = (existResp && existResp.error) || "通信失敗";
      // Native Host 未登録などの致命的エラーは即座に中断
      if (isHostMissingError(firstHostError)) {
        const help = hostMissingHelp();
        notify("Native Host 未登録", help);
        return { ok: false, error: help };
      }
      continue;
    }
    if (existResp.exists) {
      foundPath = candidate;
      break;
    }
  }

  // file 選択でファイル本体が無い場合は親フォルダで再試行
  if (!foundPath && action === "select") {
    for (const base of baseCandidates) {
      const r = await sendToHost({ action: "exists", path: base });
      if (r && r.ok && r.exists) {
        const open = await sendToHost({ action: "open", path: base });
        if (open.ok) return { ok: true, path: base };
        notify("起動失敗", open.error || "");
        return { ok: false, error: open.error || "起動失敗" };
      }
    }
  }

  if (!foundPath) {
    if (firstHostError && !triedPaths.length) {
      notify("ホストエラー", firstHostError);
      return { ok: false, error: "ホストエラー: " + firstHostError };
    }
    const msg =
      "ローカルパスが見つかりません。試したパス:\n" +
      triedPaths.map((p) => "  " + p).join("\n") +
      "\n\nオプション画面でローカルルートを確認してください。" +
      "\n例: I:\\ や I:\\共有ドライブ\\ など。";
    notify("見つかりません", msg);
    return { ok: false, error: msg };
  }

  const resp = await sendToHost({ action, path: foundPath });
  if (!resp.ok) {
    if (isHostMissingError(resp.error)) {
      const help = hostMissingHelp();
      notify("Native Host 未登録", help);
      return { ok: false, error: help };
    }
    notify("起動失敗", resp.error || "不明なエラー");
    return { ok: false, error: resp.error || "不明なエラー" };
  }
  return { ok: true, path: foundPath };
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title,
      message: String(message).slice(0, 500),
    });
  } catch (_) {
    // notifications 権限がないなど
  }
}

// ---- コンテキストメニュー --------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "エクスプローラーで開く",
    contexts: ["page", "selection", "link"],
    documentUrlPatterns: ["https://drive.google.com/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID) {
    openCurrentFolder(tab);
  }
});

// ---- popup / options / content からのメッセージ ----------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "openCurrentFolder") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const r = await openCurrentFolder(tab);
        sendResponse(r);
        return;
      }
      if (msg.type === "openTarget") {
        const r = await openTarget(msg.target);
        sendResponse(r);
        return;
      }
      if (msg.type === "openTargetWithBreadcrumbs") {
        // popup から「完全な breadcrumb」が指定されて開く
        const r = await runOpen({
          kind: "current",
          breadcrumbs: msg.breadcrumbs || [],
        });
        sendResponse(r);
        return;
      }
      // ---- Drive REST API (OAuth) -------------------------------------
      if (msg.type === "apiResolvePath") {
        try {
          const path = await DTE_API.getFolderPathCached(msg.folderId);
          sendResponse({ ok: true, breadcrumbs: path });
        } catch (e) {
          sendResponse({
            ok: false,
            error: String(e && e.message || e),
            code: e && e.code,
          });
        }
        return;
      }
      if (msg.type === "apiSignIn") {
        try {
          await DTE_API.signIn();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return;
      }
      if (msg.type === "apiSignOut") {
        try {
          await DTE_API.signOut();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return;
      }
      if (msg.type === "apiStatus") {
        const st = await DTE_API.getStatus();
        sendResponse({ ok: true, ...st });
        return;
      }
      if (msg.type === "apiSetClientId") {
        await DTE_API.setClientId(msg.clientId || "");
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "apiGetRedirectUri") {
        sendResponse({ ok: true, redirectUri: chrome.identity.getRedirectURL() });
        return;
      }
      if (msg.type === "resolvePath") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // quick モードでは「パスを表示」を叩かない (表示用)
        // 実際の起動ボタン押下時に popup から user activation 付きで取得する
        const info = tab && tab.id
          ? await getCurrentBreadcrumbs(tab.id, msg.quick ? false : true)
          : null;
        const breadcrumbs = info ? info.breadcrumbs : [];
        const localRoot = await getLocalRoot();
        // 候補のうち最初に存在するものを表示する
        let localPath = null;
        if (localRoot && breadcrumbs && breadcrumbs.length) {
          const candidates = buildLocalPathCandidates(breadcrumbs, localRoot);
          for (const c of candidates) {
            const r = await sendToHost({ action: "exists", path: c });
            if (r && r.ok && r.exists) {
              localPath = c;
              break;
            }
            // host エラー時は最初の候補を表示用に使う
            if (r && !r.ok && isHostMissingError(r.error)) {
              localPath = c;
              break;
            }
          }
          if (!localPath) localPath = candidates[0];
        }
        sendResponse({ ok: true, breadcrumbs, localPath, localRoot });
        return;
      }
      if (msg.type === "hostRequest") {
        const resp = await sendToHost(msg.payload);
        sendResponse(resp);
        return;
      }
      sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

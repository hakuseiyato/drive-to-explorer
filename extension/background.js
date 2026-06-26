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

// localRoots (新形式: array) と localRoot (旧形式: string) の両方を読んで
// 統合した配列を返す。空文字や重複は除去。
async function getLocalRoots() {
  const obj = await chrome.storage.sync.get(["localRoots", "localRoot"]);
  const arr = [];
  if (Array.isArray(obj.localRoots)) {
    for (const v of obj.localRoots) {
      if (v && typeof v === "string") arr.push(v);
    }
  }
  if (obj.localRoot && typeof obj.localRoot === "string") arr.push(obj.localRoot);
  // 重複排除 (大文字小文字無視)
  const seen = new Set();
  const result = [];
  for (const v of arr) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(trimmed);
  }
  return result;
}

// 後方互換用: 単一ルートを取得 (バッジ判定など)
async function getLocalRoot() {
  const roots = await getLocalRoots();
  return roots[0] || "";
}

// ---- パス構築 ----------------------------------------------------------

// Drive for Desktop の典型的なディレクトリ構造を試行する候補リスト
// 共有ドライブは「共有ドライブ\」、My Drive は「マイドライブ\」配下にミラーされる
// 複数 root に対応 (配列または単一文字列を受け付ける)
function buildLocalPathCandidates(breadcrumbs, localRootOrRoots) {
  const roots = Array.isArray(localRootOrRoots)
    ? localRootOrRoots
    : (localRootOrRoots ? [localRootOrRoots] : []);
  if (roots.length === 0) return [];
  const parts = (breadcrumbs || [])
    .map((s) => (s || "").trim())
    .filter((s) => s.length > 0);
  const sub = parts.join("\\");

  const candidates = [];
  for (const r of roots) {
    const root = String(r).replace(/[\\/]+$/, "");
    if (!sub) {
      candidates.push(root);
      continue;
    }
    candidates.push(
      // 1. ルート直下にそのまま
      root + "\\" + sub,
      // 2. 共有ドライブ配下
      root + "\\共有ドライブ\\" + sub,
      root + "\\Shared drives\\" + sub,
      // 3. マイドライブ配下
      root + "\\マイドライブ\\" + sub,
      root + "\\My Drive\\" + sub
    );
  }
  // 重複排除 (大文字小文字無視)
  const seen = new Set();
  const dedup = [];
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(c);
  }
  return dedup;
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

async function ensureLocalRoots() {
  const roots = await getLocalRoots();
  if (roots.length === 0) {
    notify(
      "初期設定が必要です",
      "拡張のオプションでローカルルート (例: M:\\) を設定してください。"
    );
    chrome.runtime.openOptionsPage();
    return null;
  }
  return roots;
}

async function openCurrentFolder(tab) {
  if (!tab || !tab.id) {
    const msg = "アクティブな Drive タブが見つかりません。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  // 実際にパスを開く時は完全な breadcrumb (パスを表示 popup 経由) を取る
  const info = await getCurrentBreadcrumbs(tab.id, true);
  if (!info) {
    const msg = "Drive のフォルダ階層を取得できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }

  // ファイル単体 URL (/file/d/<id>/view) の場合は kind:'file' で runOpen に流す
  // breadcrumbs は API 経由で [...親階層, ファイル名] が返る前提
  // (DOM フォールバック時はファイル名のみ)
  if (info.driveRef && info.driveRef.type === "file") {
    const bc = info.breadcrumbs || [];
    const fileName = info.fileName ||
      (bc.length ? bc[bc.length - 1] : null);
    if (!fileName) {
      const msg =
        "ファイル名を取得できませんでした。\n" +
        "OAuth 未設定の場合はオプション画面で Drive API をセットアップしてください。";
      notify("ファイル単体起動失敗", msg);
      return { ok: false, error: msg };
    }
    // 末尾がファイル名と一致する場合は親階層として除外
    const parentBc = bc.length && bc[bc.length - 1] === fileName
      ? bc.slice(0, -1)
      : bc;
    return await runOpen({
      kind: "file",
      name: fileName,
      breadcrumbs: parentBc,
      altCandidates: info.altCandidates || [],
    });
  }

  if (!info.breadcrumbs || info.breadcrumbs.length === 0) {
    const msg = "Drive のフォルダ階層を取得できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  return await runOpen({
    breadcrumbs: info.breadcrumbs,
    kind: "current",
    altCandidates: info.altCandidates || [],
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
  // file 指定なら親階層が空でもファイル名で root 配下を探す可能性があるので許容
  if (breadcrumbs.length === 0 && target.kind !== "file") {
    const msg = "Drive のフォルダ階層を取得できませんでした。";
    notify("エラー", msg);
    return { ok: false, error: msg };
  }
  const localRoots = await ensureLocalRoots();
  if (!localRoots) return { ok: false, error: "ローカルルート未設定" };

  // Drive for Desktop の構造に応じて複数候補を試行する (複数 root + altCandidates 対応)
  // target.altCandidates が指定されていれば、breadcrumbs 含めて全パターンを candidate に展開
  const breadcrumbVariants = [breadcrumbs];
  if (Array.isArray(target.altCandidates)) {
    for (const alt of target.altCandidates) {
      if (Array.isArray(alt) && alt.length) breadcrumbVariants.push(alt);
    }
  }
  const baseCandidatesSet = [];
  for (const bc of breadcrumbVariants) {
    for (const p of buildLocalPathCandidates(bc, localRoots)) {
      baseCandidatesSet.push(p);
    }
  }
  // 重複排除
  const seenBases = new Set();
  const baseCandidates = baseCandidatesSet.filter((p) => {
    const k = p.toLowerCase();
    if (seenBases.has(k)) return false;
    seenBases.add(k);
    return true;
  });
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

  // 候補のうちファイル/フォルダ本体パスと親フォルダパスを 1 リクエストで一括チェック
  const triedPaths = baseCandidates.map(buildFinal);
  const parentCheckPaths = action === "select" ? baseCandidates : [];
  const allPaths = [...triedPaths, ...parentCheckPaths];

  const existsMany = await sendToHost({ action: "exists_many", paths: allPaths });
  const hostErrors = [];
  let foundPath = null;
  let fallbackParent = null;
  if (!existsMany || !existsMany.ok) {
    const err = (existsMany && existsMany.error) || "通信失敗";
    if (isHostMissingError(err)) {
      const help = hostMissingHelp();
      notify("Native Host 未登録", help);
      return { ok: false, error: help };
    }
    hostErrors.push(`exists_many: ${err}`);
  } else {
    const results = existsMany.results || [];
    const lookup = new Map(results.map((r) => [r.path, r]));
    // 1. ファイル/フォルダ本体パスを優先
    for (const p of triedPaths) {
      const r = lookup.get(p);
      if (r && r.exists) {
        foundPath = p;
        break;
      }
      if (r && r.error) hostErrors.push(`${p}: ${r.error}`);
    }
    // 2. file 選択で本体が無い場合の親フォルダ
    if (!foundPath && action === "select") {
      for (const base of parentCheckPaths) {
        const r = lookup.get(base);
        if (r && r.exists) {
          fallbackParent = base;
          break;
        }
      }
    }
  }

  // 親フォルダフォールバック起動
  if (!foundPath && fallbackParent) {
    const open = await sendToHost({ action: "open", path: fallbackParent });
    if (open.ok) {
      notify(
        "親フォルダを開きました",
        "ローカルにファイル本体が見つからなかったため、親フォルダを開きました:\n" + fallbackParent
      );
      return { ok: true, path: fallbackParent, fallback: "parent" };
    }
    notify("起動失敗", open.error || "");
    return { ok: false, error: open.error || "起動失敗" };
  }

  if (!foundPath) {
    // ホストエラーが全候補で発生していたら原因はホスト側
    if (hostErrors.length && hostErrors.length === triedPaths.length) {
      const detail = hostErrors.join("\n");
      notify("ホストエラー", detail);
      return { ok: false, error: "ホストエラー:\n" + detail };
    }
    const msg =
      "ローカルパスが見つかりません。試したパス:\n" +
      triedPaths.map((p) => "  " + p).join("\n") +
      (hostErrors.length ? "\n\nホストエラー:\n" + hostErrors.join("\n") : "") +
      "\n\nオプション画面でローカルルートを確認してください。" +
      "\n複数ドライブの場合は 1 行に 1 つずつ指定 (例: I:\\ と M:\\) してください。";
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
  } catch (e) {
    // notifications 権限が無い等で失敗した場合も最低限ログには残す
    console.warn("[DTE] notify failed:", title, e);
  }
}

// ---- バッジ更新 --------------------------------------------------------
// 状態に応じてツールバーアイコンにバッジを表示する。
//   localRoot 未設定        : 赤 "!"   (機能不全)
//   Native Host 未登録      : 橙 "!"   (機能不全)
//   OAuth 未設定 (任意)     : バッジ無し (DOM フォールバックで動作可能)
//   全て OK                 : バッジ無し

async function pingHost() {
  const r = await sendToHost({ action: "ping" });
  return !!(r && r.ok);
}

function setBadge(text, color, title) {
  try {
    chrome.action.setBadgeText({ text: text || "" });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
    if (title) chrome.action.setTitle({ title });
  } catch (e) {
    // service worker 起動直後など稀に投げる
  }
}

// ---- アップデートチェック ----------------------------------------------
// GitHub Releases API で最新タグを取得し、現在版と比較。
// 結果は chrome.storage.local.updateAvailable に保存。バッジで通知。

const GITHUB_REPO = "hakuseiyato/drive-to-explorer";
const RELEASES_API = "https://api.github.com/repos/" + GITHUB_REPO + "/releases/latest";

function parseVersion(v) {
  // "v0.2.3" → [0, 2, 3]
  return String(v || "")
    .replace(/^v/, "")
    .split(".")
    .map((x) => parseInt(x, 10) || 0);
}
function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const ai = av[i] || 0, bi = bv[i] || 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

async function fetchLatestVersion() {
  const r = await fetch(RELEASES_API, {
    headers: { "User-Agent": "DriveToExplorer-Updater" },
  });
  if (!r.ok) {
    throw new Error("GitHub API HTTP " + r.status);
  }
  const data = await r.json();
  const tag = data.tag_name || "";
  const url = data.html_url || "";
  return { latestTag: tag, latestVersion: tag.replace(/^v/, ""), url, publishedAt: data.published_at };
}

async function performUpdateCheck() {
  const manifest = chrome.runtime.getManifest();
  const currentVersion = manifest.version;
  try {
    const { latestTag, latestVersion, url, publishedAt } = await fetchLatestVersion();
    const isOutdated = compareVersions(currentVersion, latestVersion) < 0;
    const result = {
      ok: true,
      currentVersion,
      latestVersion,
      latestTag,
      isOutdated,
      releaseUrl: url,
      publishedAt,
      checkedAt: Date.now(),
    };
    await chrome.storage.local.set({
      updateAvailable: isOutdated,
      latestVersion,
      latestTag,
      releaseUrl: url,
      updateCheckedAt: Date.now(),
    });
    // バッジ再描画
    updateBadge();
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), currentVersion };
  }
}

async function updateBadge() {
  const localRoot = await getLocalRoot();
  if (!localRoot) {
    setBadge(
      "!",
      "#c0392b",
      "Drive to Explorer — 設定未完了 (オプションでローカルルートパスを設定)"
    );
    return;
  }
  const hostOk = await pingHost();
  if (!hostOk) {
    setBadge(
      "!",
      "#e67e22",
      "Drive to Explorer — Native Host 未登録 (install.bat を実行してください)"
    );
    return;
  }
  let apiNote = "";
  try {
    const apiStatus = await DTE_API.getStatus();
    if (!apiStatus.hasClientId) {
      apiNote = " (OAuth 未設定 - DOM 解析モード)";
    } else if (!apiStatus.signedIn) {
      apiNote = apiStatus.isDefaultClientId
        ? " (OAuth 未サインイン - オプション画面でサインインしてください)"
        : " (OAuth 未サインイン - 必要時に対話認可)";
    } else {
      apiNote = apiStatus.isDefaultClientId
        ? " (API モード - 既定 Client ID)"
        : " (API モード - 独自 Client ID)";
    }
  } catch (_) {}

  // アップデート通知
  let updateNote = "";
  try {
    const { updateAvailable, latestVersion } = await chrome.storage.local.get([
      "updateAvailable", "latestVersion",
    ]);
    if (updateAvailable) {
      setBadge(
        "↑",
        "#1a73e8",
        "Drive to Explorer — 新バージョン v" + latestVersion +
        " が利用可能です。update.bat を実行してください" + apiNote
      );
      return;
    }
  } catch (_) {}

  setBadge("", "", "Drive to Explorer — 動作中" + apiNote + updateNote);
}

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
  // バッジ更新: 5 分ごと
  try { chrome.alarms.create("dte-badge-refresh", { periodInMinutes: 5 }); } catch (_) {}
  // アップデートチェック: 6 時間ごと (GitHub Rate Limit 配慮)
  try { chrome.alarms.create("dte-update-check", { periodInMinutes: 360, delayInMinutes: 1 }); } catch (_) {}
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  // 起動時にも 1 回チェック (静かにバックグラウンド)
  performUpdateCheck().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === "dte-badge-refresh") {
    updateBadge();
  }
  if (alarm && alarm.name === "dte-update-check") {
    performUpdateCheck().catch(() => {});
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    changes.localRoot ||
    changes.localRoots ||
    changes.oauthClientId ||
    changes.oauthAccessToken
  ) {
    updateBadge();
  }
});
// 起動時にも 1 度叩く (service worker は最初のメッセージで起きるため)
updateBadge();

// ---- コンテキストメニュー --------------------------------------------

function registerContextMenu() {
  // onInstalled / onStartup が連続発火するとレースで duplicate id エラーになるため
  // removeAll 後の create を try/catch + callback で受け、エラーは silently ignore
  chrome.contextMenus.removeAll(() => {
    try {
      chrome.contextMenus.create(
        {
          id: CONTEXT_MENU_ID,
          title: "エクスプローラーで開く",
          contexts: ["page", "selection", "link"],
          documentUrlPatterns: ["https://drive.google.com/*"],
        },
        () => {
          // callback 内で lastError をクリア (duplicate id 等の警告を握り潰す)
          // 既に存在していても害はないので無視
          void chrome.runtime.lastError;
        }
      );
    } catch (_) {
      // create が同期的に投げる場合 (duplicate id) も握り潰す
    }
  });
}

chrome.runtime.onInstalled.addListener(registerContextMenu);
chrome.runtime.onStartup.addListener(registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID) {
    openCurrentFolder(tab);
  }
});

// ---- キーボードショートカット --------------------------------------------
// デフォルト未割当。chrome://extensions/shortcuts で割当 (例: Ctrl+Shift+E)
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (cmd) => {
    if (cmd !== "open-current-folder") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && /^https:\/\/drive\.google\.com\//.test(tab.url || "")) {
      openCurrentFolder(tab);
    }
  });
}

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
      if (msg.type === "resolveTargetPath") {
        // 開かずにローカルパスだけ計算して返す (コピー用)
        const target = msg.target || {};
        const breadcrumbs = target.breadcrumbs || [];
        if (breadcrumbs.length === 0) {
          sendResponse({ ok: false, error: "Drive 階層が取得できませんでした" });
          return;
        }
        const localRoots = await getLocalRoots();
        if (localRoots.length === 0) {
          sendResponse({ ok: false, error: "ローカルルート未設定" });
          return;
        }
        const baseCandidates = buildLocalPathCandidates(breadcrumbs, localRoots);
        const buildFinal = (base) => {
          if (target.kind === "folder" && target.name) return base + "\\" + target.name;
          if (target.kind === "file" && target.name) return base + "\\" + target.name;
          return base;
        };
        const candidates = baseCandidates.map(buildFinal);
        const r = await sendToHost({ action: "exists_many", paths: candidates });
        if (r && r.ok && r.results) {
          const hit = r.results.find((x) => x.exists);
          if (hit) {
            sendResponse({ ok: true, path: hit.path });
            return;
          }
        } else if (r && !r.ok && isHostMissingError(r.error)) {
          // host 未登録などの致命的エラー: 通信せず候補だけ返す
          sendResponse({
            ok: true,
            path: candidates[0],
            warning: "Native Host 未登録のため存在確認はスキップ",
          });
          return;
        }
        // どれも存在しなかった: 1 番目の候補を warning 付きで返す
        sendResponse({
          ok: true,
          path: candidates[0],
          warning: "存在確認できませんでした",
        });
        return;
      }
      if (msg.type === "openTargetWithBreadcrumbs") {
        // popup から「完全な breadcrumb」が指定されて開く
        // ファイル単体URLでは msg.driveRef.type === "file" + msg.fileName で受信
        const isFile = msg.driveRef && msg.driveRef.type === "file";
        const bc = msg.breadcrumbs || [];
        const alts = msg.altCandidates || [];
        if (isFile) {
          const fileName = msg.fileName ||
            (bc.length ? bc[bc.length - 1] : null);
          const parentBc = bc.length && fileName && bc[bc.length - 1] === fileName
            ? bc.slice(0, -1)
            : bc;
          const r = await runOpen({
            kind: "file",
            name: fileName,
            breadcrumbs: parentBc,
            altCandidates: alts,
          });
          sendResponse(r);
          return;
        }
        const r = await runOpen({
          kind: "current",
          breadcrumbs: bc,
          altCandidates: alts,
        });
        sendResponse(r);
        return;
      }
      // ---- アップデートチェック ------------------------------------
      if (msg.type === "checkUpdate") {
        const r = await performUpdateCheck();
        sendResponse(r);
        return;
      }
      if (msg.type === "getCachedUpdateInfo") {
        const cached = await chrome.storage.local.get([
          "updateAvailable", "latestVersion", "latestTag", "releaseUrl", "updateCheckedAt",
        ]);
        const manifest = chrome.runtime.getManifest();
        sendResponse({
          ok: true,
          currentVersion: manifest.version,
          ...cached,
        });
        return;
      }
      // ---- ワンクリック更新の適用（Native Host に委譲） --------------
      // Host が updater.ps1 をデタッチ起動 → DL/展開/入替を実行。
      // 進捗は updateStatus でポーリングし、done で options が reload する。
      if (msg.type === "applyUpdate") {
        const r = await sendToHost({ action: "update", repo: GITHUB_REPO });
        sendResponse(r);
        return;
      }
      if (msg.type === "updateStatus") {
        const r = await sendToHost({ action: "update_status" });
        sendResponse(r);
        return;
      }
      // ---- Drive REST API (OAuth) -------------------------------------
      if (msg.type === "apiTest") {
        // アクティブな Drive タブから folder/file ID を抽出 → resolveFolderPath
        // を実行して結果またはエラー詳細を返す。診断用。
        // 検索順: (1) 全 window から Drive タブを探す → (2) フォーカス中タブ
        try {
          let tab = null;
          const driveTabs = await chrome.tabs.query({ url: "https://drive.google.com/*" });
          if (driveTabs && driveTabs.length) {
            // アクティブな Drive タブを優先、無ければ最初のもの
            tab = driveTabs.find((t) => t.active) || driveTabs[0];
          } else {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            tab = activeTab;
          }
          if (!tab || !tab.url) {
            sendResponse({
              ok: false,
              error: "Drive タブが見つかりません",
              code: "NO_TAB",
            });
            return;
          }
          let ref = null;
          let m;
          if ((m = tab.url.match(/\/file\/d\/([^/?#]+)/))) {
            ref = { type: "file", id: m[1] };
          } else if ((m = tab.url.match(/\/folders\/([^/?#]+)/))) {
            ref = { type: "folder", id: m[1] };
          } else if ((m = tab.url.match(/[?&]id=([^&#]+)/))) {
            ref = { type: "folder", id: m[1] };
          }
          if (!ref) {
            sendResponse({
              ok: false,
              error: "Drive のフォルダ／ファイル URL ではありません: " + tab.url,
              code: "NO_DRIVE_REF",
            });
            return;
          }
          const status = await DTE_API.getStatus();
          if (!status.hasClientId) {
            sendResponse({
              ok: false,
              error: "OAuth Client ID 未設定",
              code: "NO_CLIENT_ID",
              status,
            });
            return;
          }
          try {
            const path = await DTE_API.getFolderPathCached(ref.id, {
              isFileId: ref.type === "file",
            });
            sendResponse({
              ok: true,
              breadcrumbs: path,
              tabUrl: tab.url,
              driveRef: ref,
              status,
            });
          } catch (e) {
            sendResponse({
              ok: false,
              error: String(e && e.message || e),
              code: e && e.code,
              detail: e && e.status,
              tabUrl: tab.url,
              driveRef: ref,
              status,
            });
          }
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e), code: "EXCEPTION" });
        }
        return;
      }
      if (msg.type === "apiResolvePath") {
        try {
          const path = await DTE_API.getFolderPathCached(msg.folderId, {
            isFileId: !!msg.isFileId,
          });
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
        // popup / options から呼ばれた契機でバッジも更新する
        updateBadge();
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
      if (msg.type === "resolveLocalPathToFolderId") {
        try {
          const folderId = await DTE_API.findFolderIdByLocalPath(msg.localPath);
          sendResponse({ ok: true, folderId });
        } catch (e) {
          sendResponse({
            ok: false,
            error: String(e && e.message || e),
            code: e && e.code,
          });
        }
        return;
      }
      if (msg.type === "resolvePath") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // quick モードでは「パスを表示」を叩かない (表示用)
        // 実際の起動ボタン押下時に popup から user activation 付きで取得する
        const info = tab && tab.id
          ? await getCurrentBreadcrumbs(tab.id, msg.quick ? false : true)
          : null;
        const breadcrumbs = info ? (info.breadcrumbs || []) : [];
        const isFile = !!(info && info.driveRef && info.driveRef.type === "file");
        const fileName = info && info.fileName || null;
        const localRoots = await getLocalRoots();
        // 候補のうち最初に存在するものを表示する (1 リクエストで一括チェック)
        let localPath = null;
        if (localRoots.length && breadcrumbs && breadcrumbs.length) {
          const candidates = buildLocalPathCandidates(breadcrumbs, localRoots);
          const r = await sendToHost({ action: "exists_many", paths: candidates });
          if (r && r.ok && r.results) {
            const hit = r.results.find((x) => x.exists);
            localPath = hit ? hit.path : candidates[0];
          } else if (r && !r.ok && isHostMissingError(r.error)) {
            localPath = candidates[0];
          } else {
            localPath = candidates[0];
          }
        }
        sendResponse({
          ok: true,
          breadcrumbs,
          localPath,
          localRoot: localRoots[0] || "",
          localRoots,
          isFile,
          fileName,
        });
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

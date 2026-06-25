// Google Drive REST API + OAuth ヘルパ
// background.js から importScripts で読み込まれ、グローバル関数を提供する。
//
// 認可方式: chrome.identity.launchWebAuthFlow (Chrome / Brave / Edge / Vivaldi 共通動作)
// スコープ: drive.metadata.readonly (ファイル内容は読まない、最小権限)

const DTE_API = (() => {
  const CLIENT_ID_KEY = "oauthClientId";
  const TOKEN_KEY = "oauthAccessToken";
  const TOKEN_EXP_KEY = "oauthAccessTokenExpiry";
  const PATH_CACHE_KEY = "folderPathCache";
  const SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

  // DEBUG ログ (chrome.storage.local.dteDebug を非同期で読み込み)
  let DEBUG = false;
  try {
    chrome.storage.local.get("dteDebug", (o) => { DEBUG = !!(o && o.dteDebug); });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "local" && c.dteDebug) DEBUG = !!c.dteDebug.newValue;
    });
  } catch (_) {}
  function apilog(...args) {
    if (DEBUG) console.log("[DTE/API]", ...args);
  }

  // 配布物に同梱する既定の OAuth Client ID。
  // この拡張機能は manifest.key により拡張機能 ID が固定 (pkiecgch...) されているため、
  // この Client ID に紐付くリダイレクト URI (https://pkiecgch.../chromiumapp.org/) も
  // この拡張機能でしか到達できない → 第三者は悪用できない。
  // Chrome Web Store 公開拡張で oauth2.client_id を manifest に書くのと同じパターン。
  // ユーザーが個別に上書きしたい場合はオプション画面で別の Client ID を入力すれば
  // chrome.storage.sync の値が優先される。
  const DEFAULT_CLIENT_ID = "857629506756-voets6ot4b34c12fetdauc7b9a3fau3v.apps.googleusercontent.com";

  async function getClientId() {
    const { [CLIENT_ID_KEY]: id } = await chrome.storage.sync.get(CLIENT_ID_KEY);
    return id || DEFAULT_CLIENT_ID || null;
  }

  async function setClientId(id) {
    await chrome.storage.sync.set({ [CLIENT_ID_KEY]: (id || "").trim() });
  }

  async function getCachedToken() {
    const { [TOKEN_KEY]: token, [TOKEN_EXP_KEY]: exp } =
      await chrome.storage.session.get([TOKEN_KEY, TOKEN_EXP_KEY]);
    if (token && exp && Date.now() < exp - 60000) return token;
    return null;
  }

  async function setCachedToken(token, expiresInSec) {
    await chrome.storage.session.set({
      [TOKEN_KEY]: token,
      [TOKEN_EXP_KEY]: Date.now() + (expiresInSec || 3600) * 1000,
    });
  }

  async function clearCachedToken() {
    await chrome.storage.session.remove([TOKEN_KEY, TOKEN_EXP_KEY]);
  }

  async function clearPathCache() {
    await chrome.storage.session.remove(PATH_CACHE_KEY);
  }

  // 単発の launchWebAuthFlow 呼び出し (内部用)
  function _doAuthFlow(clientId, interactive) {
    const redirectUri = chrome.identity.getRedirectURL();
    // include_granted_scopes=true + 既存承認済みなら interactive: false でも
    // Google セッションが生きていれば silent に access_token が取れる
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(clientId) +
      "&response_type=token" +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&scope=" + encodeURIComponent(SCOPE) +
      "&include_granted_scopes=true";

    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url, interactive: !!interactive },
        async (responseUrl) => {
          if (chrome.runtime.lastError || !responseUrl) {
            const msg =
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
              "認可フロー失敗";
            apilog("launchWebAuthFlow error (interactive=" + interactive + "):", msg);
            const e = new Error(msg);
            e.code = interactive ? "AUTH_FAILED" : "NO_INTERACTIVE_TOKEN";
            reject(e);
            return;
          }
          const frag = responseUrl.split("#")[1] || "";
          const params = new URLSearchParams(frag);
          const token = params.get("access_token");
          const expIn = parseInt(params.get("expires_in") || "3600", 10);
          if (!token) {
            const errParam = params.get("error");
            apilog("launchWebAuthFlow no token, error param:", errParam);
            const e = new Error(
              errParam ? "OAuth エラー: " + errParam : "access_token 取得失敗"
            );
            e.code = "AUTH_FAILED";
            reject(e);
            return;
          }
          apilog("launchWebAuthFlow success (interactive=" + interactive + "), expires_in=" + expIn);
          await setCachedToken(token, expIn);
          resolve(token);
        }
      );
    });
  }

  // 戦略:
  //   1. session キャッシュの access_token が有効 → 即返す
  //   2. silent 再取得 (interactive: false) を試行
  //      Google セッション生存 + アプリ承認済みなら user gesture なしで token 取れる
  //      これにより SW 再起動 / token 期限切れ で自動復活
  //   3. silent 失敗 + 明示的に interactive 許可されている → interactive: true で認可
  //   4. interactive 不可 → 失敗
  async function getAuthToken(interactive) {
    const cached = await getCachedToken();
    if (cached) {
      apilog("getAuthToken: cached token hit");
      return cached;
    }
    apilog("getAuthToken: no cached token, interactive=" + interactive);

    const clientId = await getClientId();
    if (!clientId) {
      apilog("getAuthToken: NO_CLIENT_ID");
      const e = new Error("OAuth Client ID 未設定");
      e.code = "NO_CLIENT_ID";
      throw e;
    }

    // Step 1: silent 再取得を試みる
    try {
      const tok = await _doAuthFlow(clientId, false);
      apilog("getAuthToken: silent re-auth 成功");
      return tok;
    } catch (e) {
      apilog("getAuthToken: silent re-auth 失敗 code=" + e.code);
      if (!interactive) {
        // 上位から interactive 不可と指示されていたら、ここで失敗
        const err = new Error("silent 再取得失敗。サインインボタンを押してください");
        err.code = "NEEDS_INTERACTIVE";
        throw err;
      }
    }

    // Step 2: interactive で再認可
    apilog("getAuthToken: trying interactive auth");
    return _doAuthFlow(clientId, true);
  }

  async function signIn() {
    return getAuthToken(true);
  }

  async function signOut() {
    const token = await getCachedToken();
    if (token) {
      try {
        await fetch(
          "https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token),
          { method: "POST" }
        );
      } catch (_) {}
    }
    await clearCachedToken();
    await clearPathCache();
  }

  // 429 / 5xx は指数バックオフでリトライ (最大 2 回)
  // 401 (token 期限切れ) はキャッシュをクリアしてエラーコード 401 を上に投げる
  async function apiGet(url, token) {
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [200, 600];
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let r;
      try {
        r = await fetch(url, {
          headers: { Authorization: "Bearer " + token },
        });
      } catch (e) {
        lastErr = new Error("Drive API fetch failed: " + e.message);
        lastErr.status = 0;
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((res) => setTimeout(res, BACKOFF_MS[attempt]));
          continue;
        }
        throw lastErr;
      }
      if (r.ok) return r.json();
      // 401: token 期限切れ → セッションキャッシュ破棄
      if (r.status === 401) {
        apilog("apiGet: 401, clearing cached token");
        await clearCachedToken();
        const err = new Error("Drive API 401: unauthorized (token expired)");
        err.status = 401;
        throw err;
      }
      const isTransient = r.status === 429 || (r.status >= 500 && r.status < 600);
      const text = await r.text().catch(() => "");
      const err = new Error("Drive API " + r.status + ": " + text.slice(0, 200));
      err.status = r.status;
      if (!isTransient || attempt === MAX_ATTEMPTS - 1) throw err;
      lastErr = err;
      await new Promise((res) => setTimeout(res, BACKOFF_MS[attempt]));
    }
    throw lastErr || new Error("Drive API: unknown error after retries");
  }

  async function getFile(id, token) {
    const url =
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) +
      "?fields=id,name,parents,driveId,mimeType,shortcutDetails" +
      "&supportsAllDrives=true";
    return apiGet(url, token);
  }

  async function getDrive(driveId, token) {
    const url =
      "https://www.googleapis.com/drive/v3/drives/" + encodeURIComponent(driveId) +
      "?fields=id,name";
    return apiGet(url, token);
  }

  // folderId / fileId からフルパス (root 配下の相対) を組み立てる
  // 結果は breadcrumb 配列 (background の buildLocalPathCandidates に渡せる形)
  // - 共有ドライブ: [<sharedDriveName>, ...ancestors, currentName]
  // - My Drive: [...ancestors, currentName] (マイドライブ プレフィックスは付けない;
  //   ローカル側の prefix 試行で吸収する)
  //
  // options.isFileId が true の場合、id はファイル ID として扱い、
  //   - file が mimeType=folder の場合: 通常のフォルダ解決
  //   - file が それ以外の場合: ファイル名を末尾に含む完全な配列を返す
  async function resolveFolderPath(folderId, options) {
    if (!folderId) throw new Error("folderId 空");
    const opts = options || {};

    // getAuthToken 内部で silent → interactive の順に試行される
    // 上位から interactive 不許可指示は無いため true を渡す
    // (内部的に silent で成功すればユーザー操作は発生しない)
    let token = await getAuthToken(true);

    let current;
    try {
      current = await getFile(folderId, token);
    } catch (e) {
      // 401 なら token を再取得して 1 回リトライ
      if (e.status === 401) {
        apilog("resolveFolderPath: 401 detected, retrying with fresh token");
        token = await getAuthToken(true);
        current = await getFile(folderId, token);
      } else {
        throw e;
      }
    }

    // ショートカットの場合はターゲットを参照
    if (current.shortcutDetails && current.shortcutDetails.targetId) {
      current = await getFile(current.shortcutDetails.targetId, token);
    }

    const path = [current.name];
    const driveId = current.driveId;
    let parentId = current.parents && current.parents[0];

    let safety = 50;
    let lastAncestorError = null;
    while (parentId && safety-- > 0) {
      let parent;
      try {
        parent = await getFile(parentId, token);
      } catch (e) {
        // 権限が無い等で取れない場合は中断 (取れたところまで返す)
        lastAncestorError = e;
        console.warn("[DTE/API] 祖先取得中断 parentId=" + parentId + ": " + e.message);
        apilog("祖先取得失敗 status=" + (e.status || 0) + " parentId=" + parentId);
        break;
      }
      // 共有ドライブのトップに到達したら停止 (driveId === parent.id のケース)
      if (driveId && parent.id === driveId) break;
      // My Drive のルート (parents 無し) は path に含めない
      if (!parent.parents || parent.parents.length === 0) {
        // ただし共有ドライブ等で parents 無し & driveId 無しの場合は止める
        if (!driveId) break;
      }
      path.unshift(parent.name);
      parentId = parent.parents && parent.parents[0];
    }
    if (parentId && safety <= 0) {
      console.warn(
        "[DTE/API] 祖先階層が 50 段を超過しました。途中で打ち切ります: " +
          path.slice(0, 3).join("/") + "..."
      );
    }

    // 共有ドライブ名を先頭に
    if (driveId) {
      try {
        const drive = await getDrive(driveId, token);
        if (drive && drive.name) path.unshift(drive.name);
      } catch (_) {
        // 取れない場合は無視 (ローカル側 prefix 試行で何とかなることもある)
      }
    }

    return path;
  }

  // session キャッシュ付き
  async function getFolderPathCached(folderId, options) {
    const opts = options || {};
    const cacheKey = (opts.isFileId ? "file:" : "folder:") + folderId;
    const { [PATH_CACHE_KEY]: cache = {} } =
      await chrome.storage.session.get(PATH_CACHE_KEY);
    if (cache[cacheKey]) return cache[cacheKey];
    const path = await resolveFolderPath(folderId, opts);
    cache[cacheKey] = path;
    await chrome.storage.session.set({ [PATH_CACHE_KEY]: cache });
    return path;
  }

  async function listSharedDrives(token) {
    const url =
      "https://www.googleapis.com/drive/v3/drives" +
      "?fields=drives(id,name)&pageSize=100";
    const data = await apiGet(url, token);
    return data.drives || [];
  }

  async function findChildByName(parentId, name, driveId, token) {
    // Drive API では q パラメータの ' をエスケープする必要がある
    const safeName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q =
      "'" + parentId + "' in parents and name='" + safeName + "' and trashed=false";
    let url =
      "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&fields=files(id,name,mimeType,driveId)" +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=10";
    if (driveId) url += "&driveId=" + encodeURIComponent(driveId) + "&corpora=drive";
    const data = await apiGet(url, token);
    const files = data.files || [];
    if (files.length === 0) return null;
    // フォルダ優先 (同名ファイルがある場合)
    const folder = files.find(
      (f) => f.mimeType === "application/vnd.google-apps.folder"
    );
    return folder || files[0];
  }

  // ローカルパス -> Drive folderId
  // localRoots のいずれか、共有ドライブ/マイドライブ プレフィックスを順次剥がし、
  // 残りのセグメントを Drive 上で名前検索しながら辿る。
  async function findFolderIdByLocalPath(localPath) {
    if (!localPath) throw new Error("localPath 空");

    // 新形式 localRoots と旧形式 localRoot の両方を読む
    const obj = await chrome.storage.sync.get(["localRoots", "localRoot"]);
    const roots = [];
    if (Array.isArray(obj.localRoots)) {
      for (const r of obj.localRoots) {
        if (r && typeof r === "string") roots.push(r);
      }
    }
    if (obj.localRoot && typeof obj.localRoot === "string") roots.push(obj.localRoot);

    let rel = String(localPath);

    // 最も長く一致する root を除去 (大文字小文字無視)
    let matched = null;
    for (const r of roots) {
      const root = r.replace(/[\\/]+$/, "");
      if (rel.toLowerCase().startsWith(root.toLowerCase())) {
        if (!matched || root.length > matched.length) matched = root;
      }
    }
    if (matched) {
      rel = rel.slice(matched.length);
    }
    // ドライブレター単独 ("I:" 等) のフォールバック
    if (/^[A-Za-z]:/.test(rel)) rel = rel.slice(2);

    rel = rel.replace(/^[\\/]+/, "");

    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) {
      throw new Error("ローカルパスにフォルダ階層がありません");
    }

    let token;
    try {
      token = await getAuthToken(false);
    } catch (e) {
      if (e.code === "NO_CLIENT_ID") throw e;
      token = await getAuthToken(true);
    }

    let parentId;
    let driveId = null;

    // プレフィックス判定
    const head = parts[0];
    if (head === "共有ドライブ" || /^Shared drives$/i.test(head)) {
      parts.shift();
      if (parts.length === 0) throw new Error("共有ドライブ名が指定されていません");
      const sharedName = parts.shift();
      const drives = await listSharedDrives(token);
      const drive = drives.find((d) => d.name === sharedName);
      if (!drive) {
        throw new Error("共有ドライブが見つかりません: " + sharedName);
      }
      parentId = drive.id;
      driveId = drive.id;
    } else if (head === "マイドライブ" || /^My Drive$/i.test(head)) {
      parts.shift();
      parentId = "root";
    } else {
      // プレフィックス無し: My Drive ルートと仮定
      parentId = "root";
    }

    // 残セグメントを順次辿る
    let currentId = parentId;
    for (const seg of parts) {
      const child = await findChildByName(currentId, seg, driveId, token);
      if (!child) {
        throw new Error("Drive にフォルダが見つかりません: " + seg);
      }
      currentId = child.id;
      // ショートカット解決
      if (child.shortcutDetails && child.shortcutDetails.targetId) {
        currentId = child.shortcutDetails.targetId;
      }
    }
    return currentId;
  }

  async function getStatus() {
    const { [CLIENT_ID_KEY]: userId } = await chrome.storage.sync.get(CLIENT_ID_KEY);
    const effectiveId = userId || DEFAULT_CLIENT_ID;
    const token = await getCachedToken();
    return {
      hasClientId: !!effectiveId,
      isDefaultClientId: !userId && !!DEFAULT_CLIENT_ID,
      signedIn: !!token,
    };
  }

  return {
    getClientId,
    setClientId,
    getAuthToken,
    signIn,
    signOut,
    resolveFolderPath,
    getFolderPathCached,
    findFolderIdByLocalPath,
    getStatus,
    clearPathCache,
  };
})();

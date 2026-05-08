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

  async function getClientId() {
    const { [CLIENT_ID_KEY]: id } = await chrome.storage.sync.get(CLIENT_ID_KEY);
    return id || null;
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

  async function getAuthToken(interactive) {
    const cached = await getCachedToken();
    if (cached) return cached;

    const clientId = await getClientId();
    if (!clientId) {
      const e = new Error("OAuth Client ID 未設定");
      e.code = "NO_CLIENT_ID";
      throw e;
    }

    const redirectUri = chrome.identity.getRedirectURL();
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
            const e = new Error(msg);
            e.code = "AUTH_FAILED";
            reject(e);
            return;
          }
          const frag = responseUrl.split("#")[1] || "";
          const params = new URLSearchParams(frag);
          const token = params.get("access_token");
          const expIn = parseInt(params.get("expires_in") || "3600", 10);
          if (!token) {
            const errParam = params.get("error");
            const e = new Error(
              errParam ? "OAuth エラー: " + errParam : "access_token 取得失敗"
            );
            e.code = "AUTH_FAILED";
            reject(e);
            return;
          }
          await setCachedToken(token, expIn);
          resolve(token);
        }
      );
    });
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

  async function apiGet(url, token) {
    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      const err = new Error("Drive API " + r.status + ": " + text.slice(0, 200));
      err.status = r.status;
      throw err;
    }
    return r.json();
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

  // folderId からフルパス (root 配下の相対) を組み立てる
  // 結果は breadcrumb 配列 (background の buildLocalPathCandidates に渡せる形)
  // - 共有ドライブ: [<sharedDriveName>, ...ancestors, currentName]
  // - My Drive: [...ancestors, currentName] (マイドライブ プレフィックスは付けない;
  //   ローカル側の prefix 試行で吸収する)
  async function resolveFolderPath(folderId) {
    if (!folderId) throw new Error("folderId 空");

    let token;
    try {
      token = await getAuthToken(false);
    } catch (e) {
      if (e.code === "NO_CLIENT_ID") throw e;
      // 非対話で取れない場合は対話モード
      token = await getAuthToken(true);
    }

    let current = await getFile(folderId, token);

    // ショートカットの場合はターゲットを参照
    if (current.shortcutDetails && current.shortcutDetails.targetId) {
      current = await getFile(current.shortcutDetails.targetId, token);
    }

    const path = [current.name];
    const driveId = current.driveId;
    let parentId = current.parents && current.parents[0];

    let safety = 50;
    while (parentId && safety-- > 0) {
      let parent;
      try {
        parent = await getFile(parentId, token);
      } catch (e) {
        // 権限が無い等で取れない場合は中断 (取れたところまで返す)
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
  async function getFolderPathCached(folderId) {
    const { [PATH_CACHE_KEY]: cache = {} } =
      await chrome.storage.session.get(PATH_CACHE_KEY);
    if (cache[folderId]) return cache[folderId];
    const path = await resolveFolderPath(folderId);
    cache[folderId] = path;
    await chrome.storage.session.set({ [PATH_CACHE_KEY]: cache });
    return path;
  }

  async function getStatus() {
    const clientId = await getClientId();
    const token = await getCachedToken();
    return {
      hasClientId: !!clientId,
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
    getStatus,
    clearPathCache,
  };
})();

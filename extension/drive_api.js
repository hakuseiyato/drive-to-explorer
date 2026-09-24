// Google Drive REST API + OAuth ヘルパ
// background.js から importScripts で読み込まれ、グローバル関数を提供する。
//
// 認可方式: chrome.identity.launchWebAuthFlow (Chrome / Brave / Edge / Vivaldi 共通動作)
// スコープ: drive.metadata.readonly (ファイル内容は読まない、最小権限)

const DTE_API = (() => {
  const CLIENT_ID_KEY = "oauthClientId";
  // 旧形式 (単一アカウント) のトークンキー。全サインアウト時の掃除にのみ使う。
  const LEGACY_TOKEN_KEYS = ["oauthAccessToken", "oauthAccessTokenExpiry"];
  const ACCOUNTS_KEY = "oauthAccounts";
  const TOKENS_KEY = "oauthTokens";
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

  // サインイン済みアカウント (email) の一覧。先頭ほど優先して試す。
  // ブラウザ再起動後も login_hint 付きの無言再取得ができるよう local に永続化する。
  async function getAccounts() {
    const { [ACCOUNTS_KEY]: list } = await chrome.storage.local.get(ACCOUNTS_KEY);
    return Array.isArray(list) ? list.filter((e) => typeof e === "string" && e) : [];
  }

  async function saveAccounts(list) {
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: list });
  }

  // アクセストークンは email 単位で session に置く (1 時間で失効するため永続化しない)
  async function getTokenMap() {
    const { [TOKENS_KEY]: map } = await chrome.storage.session.get(TOKENS_KEY);
    return map && typeof map === "object" ? map : {};
  }

  async function getCachedToken(email) {
    const t = (await getTokenMap())[email];
    if (t && t.token && t.exp && Date.now() < t.exp - 60000) return t.token;
    return null;
  }

  async function setCachedToken(email, token, expiresInSec) {
    const map = await getTokenMap();
    map[email] = { token, exp: Date.now() + (expiresInSec || 3600) * 1000 };
    await chrome.storage.session.set({ [TOKENS_KEY]: map });
  }

  async function clearCachedToken(email) {
    const map = await getTokenMap();
    delete map[email];
    await chrome.storage.session.set({ [TOKENS_KEY]: map });
  }

  async function clearPathCache() {
    await chrome.storage.session.remove(PATH_CACHE_KEY);
  }

  // 単発の launchWebAuthFlow 呼び出し (内部用)。{ token, expIn } を返す。
  // キャッシュ保存は email が分かる呼び出し側で行う。
  function _doAuthFlow(clientId, { interactive, loginHint, selectAccount } = {}) {
    const redirectUri = chrome.identity.getRedirectURL();
    // include_granted_scopes=true + 既存承認済みなら interactive: false でも
    // Google セッションが生きていれば silent に access_token が取れる
    let url =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(clientId) +
      "&response_type=token" +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&scope=" + encodeURIComponent(SCOPE) +
      "&include_granted_scopes=true";
    // ブラウザに複数の Google アカウントがログインしていると、login_hint が無い
    // prompt=none は「どのアカウントか」を決められず account_selection_required で
    // 必ず失敗する (= 毎回サインインを求められる原因)。対象アカウントを明示する。
    if (loginHint) url += "&login_hint=" + encodeURIComponent(loginHint);
    // silent (非対話) 時は prompt=none を付け、Google セッションが生きていれば
    // UI を出さずにトークンを発行させる。これが無いと Google が同意/アカウント選択
    // 画面を出そうとし、非対話モードでは描画できず必ず失敗する。
    if (!interactive) url += "&prompt=none";
    else if (selectAccount) url += "&prompt=select_account";

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
          resolve({ token, expIn });
        }
      );
    });
  }

  async function requireClientId() {
    const clientId = await getClientId();
    if (!clientId) {
      apilog("NO_CLIENT_ID");
      const e = new Error("OAuth Client ID 未設定");
      e.code = "NO_CLIENT_ID";
      throw e;
    }
    return clientId;
  }

  // トークンの持ち主の email。drive.metadata.readonly スコープで取れる (スコープ追加不要)
  async function fetchAccountEmail(token) {
    const data = await apiGet(
      "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)",
      token
    );
    const email = data && data.user && data.user.emailAddress;
    if (!email) throw new Error("アカウントのメールアドレスを取得できませんでした");
    return email;
  }

  function needsInteractive(message) {
    const e = new Error(message);
    e.code = "NEEDS_INTERACTIVE";
    return e;
  }

  // 指定アカウントのトークンを得る。戦略:
  //   1. session キャッシュの access_token が有効 → 即返す
  //   2. login_hint 付きの silent 再取得 (interactive: false) を試行
  //      Google セッション生存 + アプリ承認済みなら user gesture なしで token 取れる
  //      これにより SW 再起動 / ブラウザ再起動 / token 期限切れ で自動復活
  //   3. silent 失敗 + interactive 許可 → interactive: true で認可
  //   4. interactive 不可 → NEEDS_INTERACTIVE
  async function getTokenFor(email, interactive) {
    const cached = await getCachedToken(email);
    if (cached) return cached;
    const clientId = await requireClientId();
    try {
      const r = await _doAuthFlow(clientId, { interactive: false, loginHint: email });
      apilog("getTokenFor: silent re-auth 成功 " + email);
      await setCachedToken(email, r.token, r.expIn);
      return r.token;
    } catch (e) {
      apilog("getTokenFor: silent re-auth 失敗 " + email + " code=" + e.code);
      if (!interactive) {
        throw needsInteractive(email + " の再認可に失敗しました。サインインボタンを押してください");
      }
    }
    const r = await _doAuthFlow(clientId, { interactive: true, loginHint: email });
    await setCachedToken(email, r.token, r.expIn);
    return r.token;
  }

  // 後方互換: 最優先アカウントのトークンを返す
  async function getAuthToken(interactive) {
    const accounts = await getAccounts();
    if (accounts.length === 0) {
      if (!interactive) {
        await requireClientId();
        throw needsInteractive("サインインしているアカウントがありません。サインインしてください");
      }
      await signIn();
      return getCachedToken((await getAccounts())[0]);
    }
    return getTokenFor(accounts[0], interactive);
  }

  // アカウント選択画面を出してサインインし、一覧の先頭に追加する。
  // loginHint があればそのアカウントを指定して認可する (選択画面は出さない)
  async function signIn(loginHint) {
    const clientId = await requireClientId();
    const r = await _doAuthFlow(clientId, {
      interactive: true,
      selectAccount: !loginHint,
      loginHint: loginHint || undefined,
    });
    const email = await fetchAccountEmail(r.token);
    await setCachedToken(email, r.token, r.expIn);
    const accounts = (await getAccounts()).filter((e) => e !== email);
    await saveAccounts([email, ...accounts]);
    // 別アカウントで途中までしか辿れなかったパスがキャッシュに残っていれば捨てる
    await clearPathCache();
    apilog("signIn: " + email);
    return { email };
  }

  async function revokeAndForget(email) {
    const token = await getCachedToken(email);
    if (token) {
      try {
        await fetch(
          "https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token),
          { method: "POST" }
        );
      } catch (_) {}
    }
    await clearCachedToken(email);
  }

  // email 指定でそのアカウントのみ、未指定なら全アカウントをサインアウト
  async function signOut(email) {
    const accounts = await getAccounts();
    const targets = email ? [email] : accounts;
    for (const e of targets) await revokeAndForget(e);
    await saveAccounts(email ? accounts.filter((e) => e !== email) : []);
    if (!email) await chrome.storage.session.remove([TOKENS_KEY, ...LEGACY_TOKEN_KEYS]);
    await clearPathCache();
  }

  // サインイン済みアカウントを順に試す共通経路。
  // フォルダ ID はそれを見られるアカウントのトークンでないと 404/403 になるため、
  // 失敗したら次のアカウントへ回す。成功したアカウントは先頭へ移し次回から先に試す。
  // preferEmail を渡すと、そのアカウントを最初に試す (fn には token と email を渡す)
  async function withAccounts(fn, preferEmail) {
    let accounts = await getAccounts();
    if (accounts.length === 0) {
      await requireClientId();
      accounts = await adoptSilentAccount();
      if (accounts.length === 0) {
        throw needsInteractive("サインインしているアカウントがありません。サインインしてください");
      }
    }
    if (preferEmail && accounts.includes(preferEmail)) {
      accounts = [preferEmail, ...accounts.filter((e) => e !== preferEmail)];
    }
    let lastApiError = null;
    let reauthError = null;
    for (const email of accounts) {
      let token;
      try {
        token = await getTokenFor(email, false);
      } catch (e) {
        if (e.code === "NO_CLIENT_ID") throw e;
        reauthError = e;
        continue;
      }
      try {
        let result;
        try {
          result = await fn(token, email);
        } catch (e) {
          if (e.status !== 401) throw e;
          apilog("withAccounts: 401 " + email + "、トークンを取り直して再試行");
          await clearCachedToken(email);
          result = await fn(await getTokenFor(email, false), email);
        }
        await promoteAccount(email);
        return result;
      } catch (e) {
        if (e.code === "NEEDS_INTERACTIVE") {
          reauthError = e;
          continue;
        }
        if (e.status === 403 || e.status === 404) {
          apilog("withAccounts: " + email + " では見られない (status=" + e.status + ")");
          lastApiError = e;
          continue;
        }
        throw e;
      }
    }
    // 再認可できなかったアカウントが持ち主の可能性があるため、404 より
    // 「サインインが必要」を優先して返す (サインインすれば直るので案内を出させる)
    if (reauthError) {
      throw needsInteractive(
        "再認可できないアカウントがあります。サインインし直してください (" + reauthError.message + ")"
      );
    }
    throw lastApiError;
  }

  // 並行する signIn / signOut を消さないよう、保存直前に最新の一覧を読み直して並べ替える
  async function promoteAccount(email) {
    const latest = await getAccounts();
    if (latest[0] === email || !latest.includes(email)) return;
    await saveAccounts([email, ...latest.filter((e) => e !== email)]);
  }

  // 旧版 (単一アカウント) からの移行: 一覧が空なら login_hint なしの silent 取得を
  // 1 度だけ試し、取れたら持ち主の email を一覧に登録する。Google セッションが
  // 1 つだけなら更新後も再サインイン不要。複数セッションなら失敗し従来どおり案内する。
  let adoptTried = false;
  async function adoptSilentAccount() {
    if (adoptTried) return [];
    adoptTried = true;
    try {
      const r = await _doAuthFlow(await requireClientId(), { interactive: false });
      const email = await fetchAccountEmail(r.token);
      await setCachedToken(email, r.token, r.expIn);
      await saveAccounts([email]);
      apilog("adoptSilentAccount: " + email);
      return [email];
    } catch (e) {
      apilog("adoptSilentAccount 失敗: " + e.message);
      return [];
    }
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
      // 401: token 期限切れ。キャッシュ破棄と再取得は email を知る withAccounts 側で行う
      if (r.status === 401) {
        apilog("apiGet: 401");
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

  // ドライブのルートフォルダを files.get したときに返るローカライズ済みの汎用ラベル。
  // 実際の共有ドライブ名ではないので、これを採用するとパスが必ず外れる。
  const GENERIC_ROOT_NAMES = ["ドライブ", "Drive", "マイドライブ", "My Drive"];

  // 共有ドライブ名を取得する。取れなければ null。
  // drives.get が本来の名前を返す唯一の経路だが、drive / drive.readonly スコープを
  // 要求するため、本拡張の drive.metadata.readonly では 403 になることがある。
  // files.get(driveId) は同スコープで通るが「ドライブ」等の汎用ラベルしか返さない
  // ため代替にならない。null を返した場合は background 側でローカルの
  // <root>\共有ドライブ\* を列挙して補完する。
  async function getDriveName(driveId, token) {
    try {
      const d = await getDrive(driveId, token);
      if (d && d.name) return d.name;
    } catch (e) {
      apilog("getDriveName: drives.get 失敗 status=" + (e.status || 0) + " " + e.message);
    }
    try {
      const f = await getFile(driveId, token);
      if (f && f.name && !GENERIC_ROOT_NAMES.includes(f.name)) return f.name;
      if (f && f.name) {
        apilog("getDriveName: files.get は汎用名 '" + f.name + "' を返したため不採用");
      }
    } catch (e) {
      apilog("getDriveName: files.get 失敗 status=" + (e.status || 0) + " " + e.message);
    }
    return null;
  }

  // folderId / fileId からフルパス (root 配下の相対) を組み立てる
  // 結果は breadcrumb 配列 (background の buildLocalPathCandidates に渡せる形)
  // - 共有ドライブ: [<sharedDriveName>, ...ancestors, currentName]
  // - My Drive: [...ancestors, currentName] (マイドライブ プレフィックスは付けない;
  //   ローカル側の prefix 試行で吸収する)
  //
  // Google ネイティブ形式 → Drive for desktop がミラーに書き出す拡張子。
  // 通常のバイナリファイル (mimeType が image/png 等) は Drive 上の name に
  // 既に拡張子が含まれるため、ここでは何も足さない。
  const GOOGLE_NATIVE_EXT = {
    "application/vnd.google-apps.document": ".gdoc",
    "application/vnd.google-apps.spreadsheet": ".gsheet",
    "application/vnd.google-apps.presentation": ".gslides",
    "application/vnd.google-apps.drawing": ".gdraw",
    "application/vnd.google-apps.form": ".gform",
    "application/vnd.google-apps.script": ".gscript",
    "application/vnd.google-apps.site": ".gsite",
    "application/vnd.google-apps.jam": ".gjam",
    "application/vnd.google-apps.map": ".gmap",
  };

  // Drive 上の表示名 → ローカルミラー上の実体名。
  // 既に同じ拡張子が付いている場合は二重付与しない。
  function mirrorFileName(name, mimeType) {
    const ext = GOOGLE_NATIVE_EXT[mimeType];
    if (!ext || !name) return name;
    if (name.toLowerCase().endsWith(ext)) return name;
    return name + ext;
  }

  // 最小の動作チェック (フレームワーク不要)
  console.assert(
    mirrorFileName("議事録", "application/vnd.google-apps.document") === "議事録.gdoc" &&
      mirrorFileName("表.gsheet", "application/vnd.google-apps.spreadsheet") === "表.gsheet" &&
      mirrorFileName("a.png", "image/png") === "a.png" &&
      mirrorFileName("Work", "application/vnd.google-apps.folder") === "Work",
    "[DTE/API] mirrorFileName self-check failed"
  );

  // 種別は mimeType から判定するため、呼び出し側が事前に file/folder を知る必要はない。
  // (options は後方互換のため受け取るだけで参照しない)
  //
  // Google ネイティブ形式 (ドキュメント/スプレッドシート等) は Drive for desktop の
  // ミラー上では拡張子付きのショートカットファイルとして実体化されるため、
  // path 末尾と name にはローカル実体名 (拡張子付き) を入れる。
  async function resolveFolderPathDetailed(id, options) {
    if (!id) throw new Error("folderId 空");

    // 自動解決経路 (popup / content からの apiResolvePath) はユーザージェスチャが
    // 伝播しないため interactive 認証は成立しない。withAccounts は silent 専用で、
    // どのアカウントもトークンが無ければ NEEDS_INTERACTIVE を投げて上位に伝える。
    // 対話的サインインはオプション/ popup の明示ボタン (signIn) からのみ行う。
    // 祖先を途中までしか辿れなかった結果 (共有ドライブ内のファイルが個人アカウントに
    // 直接共有されている等) は暫定とし、他のアカウントで完全に辿れればそちらを採用する。
    let partial = null;
    try {
      return await withAccounts(async (token) => {
        const d = await resolveWithToken(id, token);
        if (!d.partial) return d;
        partial = partial || d;
        const e = new Error("このアカウントでは祖先階層を辿れません");
        e.status = 403;
        throw e;
      });
    } catch (e) {
      if (partial) return partial;
      throw e;
    }
  }

  async function resolveWithToken(id, token) {
    let current = await getFile(id, token);

    // ショートカットの場合はターゲットを参照
    if (current.shortcutDetails && current.shortcutDetails.targetId) {
      current = await getFile(current.shortcutDetails.targetId, token);
    }

    const localName = mirrorFileName(current.name, current.mimeType);
    const path = [localName];
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

    // 共有ドライブ名を先頭に。
    // ここが欠けるとローカルパスが <root>\共有ドライブ\<ドライブ名>\... と
    // 一致せず必ず解決失敗するので、失敗は握り潰さず警告を出す。
    if (driveId) {
      const driveName = await getDriveName(driveId, token);
      if (driveName) {
        path.unshift(driveName);
      } else {
        console.warn(
          "[DTE/API] 共有ドライブ名を取得できませんでした (driveId=" + driveId + ")。" +
            "ローカルパスの先頭が欠けるため解決に失敗する可能性があります。"
        );
      }
    }

    return {
      path,
      isFolder: current.mimeType === "application/vnd.google-apps.folder",
      name: localName,
      mimeType: current.mimeType || null,
      partial: !!lastAncestorError,
    };
  }

  async function resolveFolderPath(folderId, options) {
    const detailed = await resolveFolderPathDetailed(folderId, options);
    return detailed.path;
  }

  // session キャッシュ付き
  async function getFolderPathDetailedCached(id, options) {
    const opts = options || {};
    const cacheKey = "v2:" + id;
    const { [PATH_CACHE_KEY]: cache = {} } =
      await chrome.storage.session.get(PATH_CACHE_KEY);
    if (cache[cacheKey]) return cache[cacheKey];
    const detailed = await resolveFolderPathDetailed(id, opts);
    cache[cacheKey] = detailed;
    await chrome.storage.session.set({ [PATH_CACHE_KEY]: cache });
    return detailed;
  }

  async function getFolderPathCached(folderId, options) {
    const detailed = await getFolderPathDetailedCached(folderId, options);
    return detailed.path;
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
  // preferEmail: ローカルパスのドライブの持ち主 (ボリュームラベル由来)。最初に試す。
  // 返り値: { folderId, email }
  async function findFolderIdByLocalPath(localPath, preferEmail) {
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

    // 返り値に「見つけたアカウント」を含め、呼び出し側が ?authuser= でそのアカウントの
    // Drive を開けるようにする (/u/0 固定だと別アカウントのフォルダは開けない)
    const walk = async (token, email) => ({
      folderId: await walkLocalParts(parts.slice(), token),
      email,
    });
    try {
      return await withAccounts(walk, preferEmail);
    } catch (e) {
      const preferMissing =
        preferEmail && !(await getAccounts()).includes(preferEmail) &&
        (e.status === 403 || e.status === 404);
      if (e.code !== "NEEDS_INTERACTIVE" && !preferMissing) throw e;
      // 従来の「silent 失敗なら interactive にフォールバック」に相当。
      // ドライブの持ち主が分かっていれば、そのアカウントを指定してサインインさせる
      await signIn(preferEmail || undefined);
      return withAccounts(walk, preferEmail);
    }
  }

  // Drive 上を名前で辿って folderId を返す。見つからなければ status=404 を付けて
  // withAccounts に次のアカウントを試させる。
  async function walkLocalParts(parts, token) {
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
        const err = new Error("共有ドライブが見つかりません: " + sharedName);
        err.status = 404;
        throw err;
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
        const err = new Error("Drive にフォルダが見つかりません: " + seg);
        err.status = 404;
        throw err;
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
    const accounts = await getAccounts();
    return {
      hasClientId: !!effectiveId,
      isDefaultClientId: !userId && !!DEFAULT_CLIENT_ID,
      signedIn: accounts.length > 0,
      accounts,
    };
  }

  return {
    getAccounts,
    getClientId,
    setClientId,
    getAuthToken,
    signIn,
    signOut,
    resolveFolderPathDetailed,
    resolveFolderPath,
    getFolderPathDetailedCached,
    getFolderPathCached,
    findFolderIdByLocalPath,
    getStatus,
    clearPathCache,
  };
})();

// Drive Web 用 content script
// - パンくず取得 (popup / background から呼ばれる)
// - 「フォルダ情報」サブメニューに「エクスプローラーで開く」項目を注入
// - 「パスを表示」ボタンを内部的にクリックして完全なパスを取得

(function () {
  // DEBUG フラグは chrome.storage.local の dteDebug から非同期で読み込む。
  // 起動時のログはバッファして、フラグ取得後にまとめて出力する。
  let DEBUG = false;
  const _logBuffer = [];
  const dlog = (...args) => {
    if (DEBUG) {
      console.log("[DTE]", ...args);
    } else {
      _logBuffer.push(args);
      if (_logBuffer.length > 200) _logBuffer.shift();
    }
  };
  try {
    chrome.storage.local.get("dteDebug", (obj) => {
      DEBUG = !!(obj && obj.dteDebug);
      if (DEBUG) {
        _logBuffer.forEach((a) => console.log("[DTE]", ...a));
      }
      _logBuffer.length = 0;
    });
  } catch (_) {}
  dlog("content script loaded", location.href);

  // ----------------------------------------------------------------------
  // Explorer → Drive Web リダイレクト
  // URL fragment "#dte_resolve=<encoded local path>" を検出して、
  // ローカルパス → folderId 解決後 /drive/u/0/folders/<id> に遷移。
  // ----------------------------------------------------------------------
  (function handleDteResolveFragment() {
    const hash = location.hash || "";
    const m = hash.match(/dte_resolve=([^&]+)/);
    if (!m) return;
    let localPath = "";
    try {
      localPath = decodeURIComponent(m[1]);
    } catch (_) {
      return;
    }
    if (!localPath) return;

    // 簡易オーバーレイで状態表示
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(20,20,20,0.85);" +
      "color:#fff;display:flex;align-items:center;justify-content:center;" +
      "font:16px/1.5 'Segoe UI','Yu Gothic UI',sans-serif;text-align:center;padding:20px;";
    overlay.innerHTML =
      '<div><div style="font-size:18px;margin-bottom:12px;">Drive で開く</div>' +
      '<div id="__dte_resolve_msg__" style="opacity:0.85;">解決中…</div>' +
      '<div style="margin-top:12px;font-size:12px;opacity:0.6;">' +
      escapeHtml(localPath) +
      "</div></div>";
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
      );
    }
    function setMsg(t, color) {
      const el = document.getElementById("__dte_resolve_msg__");
      if (el) {
        el.textContent = t;
        if (color) el.style.color = color;
      }
    }
    document.documentElement.appendChild(overlay);

    // URL から fragment を消しておく (履歴を汚さない)
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_) {}

    chrome.runtime.sendMessage(
      { type: "resolveLocalPathToFolderId", localPath },
      (resp) => {
        if (chrome.runtime.lastError) {
          setMsg("拡張通信エラー: " + chrome.runtime.lastError.message, "#ff8a8a");
          return;
        }
        if (resp && resp.ok && resp.folderId) {
          setMsg("遷移します…", "#a0e0a0");
          setTimeout(() => {
            location.replace(
              "https://drive.google.com/drive/u/0/folders/" +
                encodeURIComponent(resp.folderId)
            );
          }, 200);
          return;
        }
        const errMsg = (resp && resp.error) || "解決に失敗しました";
        const codeHint =
          resp && resp.code === "NO_CLIENT_ID"
            ? "\n\nオプション画面で OAuth Client ID を設定してサインインしてください。"
            : "";
        setMsg(errMsg + codeHint, "#ff8a8a");
        // 5 秒後にオーバーレイを閉じる
        setTimeout(() => {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 8000);
      }
    );
  })();


  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ----------------------------------------------------------------------
  // 共通ユーティリティ
  // ----------------------------------------------------------------------
  function textOf(el) {
    return (el && (el.innerText || el.textContent) || "").trim();
  }

  // フォルダ名らしいテキストか判定 (区切り記号・カウンタ・記号類を弾く)
  function looksLikeBreadcrumbItem(t) {
    if (!t) return false;
    if (t.length > 120) return false;
    if (t === ">" || t === "›" || t === "/" || t === "\\") return false;
    if (/^[…\.\s]+$/.test(t)) return false;       // 「…」「...」のみ
    if (/^[\d\s,.]+$/.test(t)) return false;      // 数字・カンマのみ (通知バッジ)
    if (t.length === 1 && !/[\p{L}\p{N}]/u.test(t)) return false;
    return true;
  }

  // 実ユーザー操作と区別不能なクリックイベント列を発火
  // (Drive は jsaction で pointerdown/mousedown に紐付いているため、Element.click() では効かない)
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      buttons: 1,
    };
    const pInit = {
      ...init,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      pressure: 0.5,
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", pInit));
      el.dispatchEvent(new PointerEvent("pointerenter", pInit));
      el.dispatchEvent(new MouseEvent("mouseover", init));
      el.dispatchEvent(new MouseEvent("mouseenter", init));
      el.dispatchEvent(new PointerEvent("pointerdown", pInit));
      el.dispatchEvent(new MouseEvent("mousedown", init));
      el.focus && el.focus();
      el.dispatchEvent(new PointerEvent("pointerup", { ...pInit, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
    } catch (e) {
      dlog("realClick failed", e);
    }
  }

  function getFolderIdFromUrl() {
    const m = location.pathname.match(/\/folders\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // /folders/<id> / /file/d/<id> / ?id=<id> を網羅
  // 戻り値: { type:'folder'|'file', id:string } | null
  function getDriveRefFromUrl(urlString) {
    const u = urlString || location.href;
    let m;
    if ((m = u.match(/\/file\/d\/([^/?#]+)/))) return { type: "file", id: m[1] };
    if ((m = u.match(/\/folders\/([^/?#]+)/))) return { type: "folder", id: m[1] };
    if ((m = u.match(/[?&]id=([^&#]+)/))) {
      // open?id=... は folder/file 不明 (API で判別)
      return { type: "folder", id: m[1] };
    }
    return null;
  }

  // ファイル単体プレビュー画面 (/file/d/<id>/view) でファイル名を取得
  function getCurrentFileName() {
    // 1. document.title 先頭 (「<filename> - Google ドライブ」)
    const m = document.title && document.title.match(/^(.+?)\s*[-–]\s*Google/i);
    if (m && m[1]) {
      const head = m[1].trim();
      if (head && head.length < 300 && !/^Google/i.test(head)) return head;
    }
    // 2. heading 要素フォールバック
    const h = document.querySelector('[role="heading"]');
    if (h) {
      const t = textOf(h);
      if (t && t.length < 300) return t;
    }
    return null;
  }

  // breadcrumb バー上の「パスを表示」ボタンと「現在フォルダ」ボタンの間にある
  // 可視のフォルダ名要素を取得する。
  // (Drive UI は折り畳まれた祖先のみを popup に出し、可視部分の中間祖先はバー上に残す)
  function getVisibleMidBreadcrumbs() {
    const showBtn = Array.from(
      document.querySelectorAll('[role="button"][aria-label]')
    ).find((b) => {
      const al = (b.getAttribute("aria-label") || "").trim();
      return al === "パスを表示" || /^Show path$/i.test(al);
    });
    if (!showBtn) return [];
    const showRect = showBtn.getBoundingClientRect();

    // 現在フォルダのボタン (aria-label === text の純粋なフォルダ名ボタン)
    let currentBtn = null;
    const headerBtns = document.querySelectorAll('[role="button"][aria-label]');
    for (const b of headerBtns) {
      const r = b.getBoundingClientRect();
      if (Math.abs(r.top - showRect.top) > 10) continue;
      if (r.left <= showRect.right) continue;
      const al = (b.getAttribute("aria-label") || "").trim();
      const tx = textOf(b);
      if (al && tx && al === tx && looksLikeBreadcrumbItem(al)) {
        if (!currentBtn || r.left > currentBtn.getBoundingClientRect().left) {
          currentBtn = b;
        }
      }
    }
    const currRect = currentBtn ? currentBtn.getBoundingClientRect() : null;

    // パスを表示の右、現在フォルダの左にある要素を全タイプ走査
    const candidates = document.querySelectorAll(
      '[role="link"], [role="button"], a, span[tabindex], div[tabindex]'
    );
    const found = [];
    const seenTexts = new Set();
    candidates.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - showRect.top) > 10) return;
      if (r.left <= showRect.right) return;
      if (currRect && r.right >= currRect.left) return;
      if (el === showBtn || el === currentBtn) return;
      const t = textOf(el);
      if (!looksLikeBreadcrumbItem(t)) return;
      if (seenTexts.has(t)) return;
      // 子要素にもマッチしているケースを除外
      const inner = el.querySelector('[role="link"], [role="button"], a');
      if (inner && textOf(inner) === t) return;
      seenTexts.add(t);
      found.push({ x: r.left, t });
    });
    // x 座標順
    found.sort((a, b) => a.x - b.x);
    return found.map((f) => f.t);
  }

  // 現在開いているフォルダの名前を取得
  // 「パスを表示」popup には祖先しか含まれないため、末尾にこれを追加する
  function getCurrentFolderName() {
    // 1. ヘッダ領域のフォルダ名ボタン (例: aria="TD" text="TD")
    const headerBtns = document.querySelectorAll('[role="button"][aria-label]');
    for (const b of headerBtns) {
      const r = b.getBoundingClientRect();
      if (r.top < 30 || r.top > 150) continue; // breadcrumb 行の y 帯
      const al = (b.getAttribute("aria-label") || "").trim();
      const tx = textOf(b);
      // aria-label と表示テキストが一致する純粋なフォルダ名ボタンを優先
      if (al && tx && al === tx && looksLikeBreadcrumbItem(al)) {
        return al;
      }
    }
    // 2. document.title 先頭セグメント
    const m = document.title && document.title.match(/^(.+?)\s*[-–]\s*/);
    if (m && m[1]) {
      const head = m[1].trim();
      // 「Google ドライブ」のみのケースを除外
      if (head && !/^Google/i.test(head) && head.length < 200) {
        return head;
      }
    }
    // 3. heading 要素
    const h = document.querySelector(
      'main [role="heading"], div[role="main"] [role="heading"], header [role="heading"]'
    );
    if (h) {
      const t = textOf(h);
      if (looksLikeBreadcrumbItem(t)) return t;
    }
    return null;
  }

  // ----------------------------------------------------------------------
  // パスを表示 popup 経由で完全なパスを取得
  // ----------------------------------------------------------------------
  async function readPathViaShowPath() {
    const showBtn = Array.from(
      document.querySelectorAll('[role="button"][aria-label]')
    ).find((b) => {
      const al = (b.getAttribute("aria-label") || "").trim();
      return al === "パスを表示" || /^Show path$/i.test(al);
    });
    if (!showBtn) {
      dlog("readPathViaShowPath: 「パスを表示」ボタン無し");
      return null;
    }

    // クリック前に「既存の popup 候補」のみ記録 (body 全要素走査を避ける)
    const POPUP_SELECTOR =
      '[role="menu"], [role="dialog"], [role="tooltip"], [role="listbox"], [role="tree"]';
    const before = new WeakSet();
    document.querySelectorAll(POPUP_SELECTOR).forEach((el) => before.add(el));

    realClick(showBtn);

    // 出現要素を 800ms ポーリングで監視
    let popup = null;
    for (let i = 0; i < 40; i++) {
      await sleep(20);
      // 新たに DOM に追加されて、複数のフォルダ名らしきテキストを含む要素を探す
      // 戦略: 新規追加された要素の中で、最も多くの breadcrumb 候補テキストを含むもの
      let bestEl = null;
      let bestCount = 0;
      const newEls = document.querySelectorAll(POPUP_SELECTOR);
      newEls.forEach((el) => {
        if (before.has(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        // 内部のテキスト要素数で評価
        const items = el.querySelectorAll(
          '[role="menuitem"], [role="treeitem"], [role="link"], [role="option"], a, [jsname]'
        );
        let cnt = 0;
        items.forEach((it) => {
          if (looksLikeBreadcrumbItem(textOf(it))) cnt++;
        });
        if (cnt > bestCount) {
          bestCount = cnt;
          bestEl = el;
        }
      });
      if (bestEl && bestCount >= 1) {
        popup = bestEl;
        break;
      }
    }

    if (!popup) {
      dlog("readPathViaShowPath: popup を検出できず");
      return null;
    }

    // popup からパスを抽出
    const arr = [];
    const items = popup.querySelectorAll(
      '[role="menuitem"], [role="treeitem"], [role="link"], [role="option"], a'
    );
    items.forEach((it) => {
      const t = textOf(it);
      if (!looksLikeBreadcrumbItem(t)) return;
      if (arr.length && arr[arr.length - 1] === t) return;
      arr.push(t);
    });

    // popup を閉じる前に、breadcrumb バーの可視中間祖先を取得する
    // (popup は折り畳まれた祖先のみ → バーには「... > Yato > TD」のように
    //  折り畳まれていない祖先 (例: Yato) と現在フォルダが残っている)
    const visibleMid = getVisibleMidBreadcrumbs();
    const current = getCurrentFolderName();

    // popup を閉じる (Esc + 外側クリック)
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
      );
      document.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true })
      );
    } catch (_) {}
    await sleep(20);
    try {
      realClick(document.body);
    } catch (_) {}

    // 結果を組み立て: popup (祖先) + visibleMid (中間) + current (現在)
    visibleMid.forEach((t) => {
      if (arr.length && arr[arr.length - 1] === t) return;
      if (arr.includes(t)) return;
      arr.push(t);
    });
    if (current && (arr.length === 0 || arr[arr.length - 1] !== current)) {
      arr.push(current);
    }

    dlog("readPathViaShowPath: result=", arr, "visibleMid=", visibleMid, "current=", current);
    return arr.length ? arr : null;
  }

  // ----------------------------------------------------------------------
  // パンくず抽出 (フォールバック群)
  // ----------------------------------------------------------------------
  // aria-label が「<name> に移動」「Go to <name>」のボタン群から抽出
  function extractBreadcrumbsByAria() {
    const btns = document.querySelectorAll('[role="button"][aria-label], a[aria-label]');
    const arr = [];
    btns.forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.top > 200 || r.top < 0) return;
      const al = (b.getAttribute("aria-label") || "").trim();
      if (!al) return;
      let name = null;
      let m;
      if ((m = al.match(/^(.+?)\s*に移動$/))) name = m[1];
      else if ((m = al.match(/^Go to\s+(.+?)$/i))) name = m[1];
      if (!name) return;
      name = name.trim();
      if (!looksLikeBreadcrumbItem(name)) return;
      if (arr.length && arr[arr.length - 1] === name) return;
      arr.push(name);
    });
    return arr;
  }

  // document.title から推定
  // Drive Web の title 形式 (現代 UI で観測):
  //   「<current> - <parent> - Google ドライブ」 (current が左、root が右)
  // そのため split したら reverse して [parent, current] (= root → current 順) にする。
  // 単一セグメントの場合は 1 要素配列。
  // 環境差で逆順の可能性もあるため、extractBreadcrumbs 側で両順を candidates に積む。
  function extractBreadcrumbsByTitle() {
    const m = document.title && document.title.match(/^(.+?)\s*[-–]\s*Google/i);
    if (!m || !m[1]) return [];
    const head = m[1].trim();
    if (!head || head.length > 200) return [];
    const parts = head.split(/\s+[-–]\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) return parts.length ? parts : [head];
    // Drive 現 UI: current - parent - Google → reverse して parent - current
    return parts.slice().reverse();
  }

  function extractBreadcrumbs() {
    // 1. aria-label ベース (「<name> に移動」)
    const ariaArr = extractBreadcrumbsByAria();
    // 2. 旧来 DOM セレクタ
    const candidates = [];
    if (ariaArr.length) candidates.push(ariaArr);

    const selectors = [
      'div[role="navigation"] [role="button"]',
      '[data-target="breadcrumbs"] [role="button"]',
      '[aria-label="ロケーション"] [role="button"]',
      '[aria-label*="Location"] [role="button"]',
    ];
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (_) {
        continue;
      }
      if (!nodes || !nodes.length) continue;
      const arr = [];
      nodes.forEach((b) => {
        const t = textOf(b);
        if (!looksLikeBreadcrumbItem(t)) return;
        if (arr.length && arr[arr.length - 1] === t) return;
        arr.push(t);
      });
      if (arr.length) candidates.push(arr);
    }

    // 3. title フォールバック (両順を候補に)
    const titleArr = extractBreadcrumbsByTitle();
    if (titleArr.length) {
      candidates.push(titleArr);
      if (titleArr.length > 1) {
        // 環境差吸収: 逆順も candidates に push (buildLocalPathCandidates で両試行される)
        candidates.push(titleArr.slice().reverse());
      }
    }

    // 最も階層が深いものを採用
    candidates.sort((a, b) => b.length - a.length);
    const result = (candidates[0] || []).filter((s) => s && s.length < 200);
    dlog("extractBreadcrumbs result=", result, "all candidates=", candidates);
    return result;
  }

  // 両順 candidates 含むすべての breadcrumb 候補配列を返す
  // (background.js が複数候補から buildLocalPathCandidates を生成するため)
  function extractAllBreadcrumbCandidates() {
    const out = [];
    const aria = extractBreadcrumbsByAria();
    if (aria.length) out.push(aria);

    const selectors = [
      'div[role="navigation"] [role="button"]',
      '[data-target="breadcrumbs"] [role="button"]',
      '[aria-label="ロケーション"] [role="button"]',
      '[aria-label*="Location"] [role="button"]',
    ];
    for (const sel of selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      if (!nodes || !nodes.length) continue;
      const arr = [];
      nodes.forEach((b) => {
        const t = textOf(b);
        if (!looksLikeBreadcrumbItem(t)) return;
        if (arr.length && arr[arr.length - 1] === t) return;
        arr.push(t);
      });
      if (arr.length) out.push(arr);
    }

    const titleArr = extractBreadcrumbsByTitle();
    if (titleArr.length) {
      out.push(titleArr);
      if (titleArr.length > 1) out.push(titleArr.slice().reverse());
    }
    // 重複配列を除去
    const seen = new Set();
    const dedup = [];
    for (const arr of out) {
      const key = arr.join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(arr);
    }
    return dedup;
  }

  // 完全なパス取得 (メイン): まず「パスを表示」、ダメならフォールバック
  // background に Drive API 経由のパス解決を依頼する
  async function getBreadcrumbsByApi() {
    const folderId = getFolderIdFromUrl();
    if (!folderId) return null;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "apiResolvePath", folderId },
          (resp) => {
            if (chrome.runtime.lastError) {
              dlog("apiResolvePath lastError", chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            if (resp && resp.ok && resp.breadcrumbs && resp.breadcrumbs.length) {
              resolve(resp.breadcrumbs);
              return;
            }
            if (resp && resp.code === "NO_CLIENT_ID") {
              dlog("API: client id not configured, fall back to DOM");
            } else {
              dlog("apiResolvePath failed", resp);
            }
            resolve(null);
          }
        );
      } catch (e) {
        dlog("apiResolvePath threw", e);
        resolve(null);
      }
    });
  }

  // ファイル単体URL (/file/d/<id>) では DOM パンくずが取れないため、
  // API 経由でファイルの親フォルダを解決する。
  async function getBreadcrumbsByApiForFile() {
    const ref = getDriveRefFromUrl();
    if (!ref || ref.type !== "file") return null;
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "apiResolvePath", folderId: ref.id, isFileId: true },
          (resp) => {
            if (chrome.runtime.lastError) {
              dlog("apiResolvePath(file) lastError", chrome.runtime.lastError.message);
              resolve(null);
              return;
            }
            if (resp && resp.ok && resp.breadcrumbs && resp.breadcrumbs.length) {
              resolve(resp.breadcrumbs);
              return;
            }
            dlog("apiResolvePath(file) failed", resp);
            resolve(null);
          }
        );
      } catch (e) {
        dlog("apiResolvePath(file) threw", e);
        resolve(null);
      }
    });
  }

  // 完全なパス取得 (メイン): API → 「パスを表示」popup → DOM の順に試行
  // ファイル単体URLでは file ID から親フォルダ解決を試す
  // 戻り値に source / fallback candidates を含めるため非標準形式に変更:
  //   { breadcrumbs: string[], source: "api"|"show-path"|"dom-title"|"file-name-only",
  //     altCandidates: string[][] }
  async function getFullBreadcrumbsDetailed() {
    const ref = getDriveRefFromUrl();
    // ファイル単体URLは API 経由でしか解決できない
    if (ref && ref.type === "file") {
      try {
        const api = await getBreadcrumbsByApiForFile();
        if (api && api.length) {
          dlog("getFullBreadcrumbs(file): via API", api);
          return { breadcrumbs: api, source: "api", altCandidates: [] };
        }
      } catch (e) {
        dlog("API file path resolve threw", e);
      }
      // ファイル単体URLで API 解決失敗時のフォールバック: title からファイル名のみ返す
      const name = getCurrentFileName();
      return {
        breadcrumbs: name ? [name] : [],
        source: "file-name-only",
        altCandidates: [],
      };
    }

    // 1. Drive REST API (OAuth) - 設定済みなら最も信頼できる
    try {
      const api = await getBreadcrumbsByApi();
      if (api && api.length) {
        dlog("getFullBreadcrumbs: via API", api);
        return { breadcrumbs: api, source: "api", altCandidates: [] };
      }
    } catch (e) {
      dlog("API path resolve threw", e);
    }
    // 2. パスを表示 popup 経由 (user activation 必要)
    try {
      const full = await readPathViaShowPath();
      if (full && full.length >= 1) {
        dlog("getFullBreadcrumbs: via show-path", full);
        return { breadcrumbs: full, source: "show-path", altCandidates: [] };
      }
    } catch (e) {
      dlog("readPathViaShowPath threw", e);
    }
    // 3. DOM / title フォールバック (両順含む全 candidate を返す)
    const primary = extractBreadcrumbs();
    const all = extractAllBreadcrumbCandidates();
    // primary 以外を altCandidates として保持 (background で複数試行)
    const altCandidates = all.filter((arr) => arr.join("|") !== primary.join("|"));
    dlog("getFullBreadcrumbs: via dom-title", primary, "alts=", altCandidates);
    return { breadcrumbs: primary, source: "dom-title", altCandidates };
  }

  // 後方互換: 文字列配列のみ返す既存 API
  async function getFullBreadcrumbs() {
    const r = await getFullBreadcrumbsDetailed();
    return r.breadcrumbs;
  }

  // ----------------------------------------------------------------------
  // 選択中の行から対象を取得
  // ----------------------------------------------------------------------
  function cleanRowName(s) {
    if (!s) return s;
    s = s.split("\n")[0].trim();
    s = s.replace(/\s+/g, " ");
    const cuts = [
      " 共有フォルダ", " フォルダ", " ファイル", " 詳細", " アクティビティ",
      "（Alt+", " (Alt+", " のオプション", " options",
      " Shared folder", " Folder",
    ];
    for (const c of cuts) {
      const i = s.indexOf(c);
      if (i > 0) s = s.slice(0, i);
    }
    return s.trim();
  }

  function extractRowName(row) {
    if (!row) return null;
    const aria = (row.getAttribute("aria-label") || "").trim();
    if (aria) {
      const head = aria.split(/[,、]/)[0].trim();
      const cleaned = cleanRowName(head || aria);
      if (cleaned && cleaned.length < 200) return cleaned;
    }
    const cells = row.querySelectorAll('[role="gridcell"]');
    for (const c of cells) {
      const clone = c.cloneNode(true);
      clone.querySelectorAll('[role="button"], button').forEach((b) => {
        const al = (b.getAttribute("aria-label") || "").trim();
        if (/詳細|Alt\+|アクティビティ|options/i.test(al)) b.remove();
      });
      const t = (clone.innerText || clone.textContent || "").trim();
      const cleaned = cleanRowName(t);
      if (cleaned && cleaned.length < 200) return cleaned;
    }
    const t = (row.innerText || "").trim();
    return t ? cleanRowName(t) : null;
  }

  function looksLikeFolder(row, name) {
    if (!row) return false;
    const aria = (row.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("フォルダ") || aria.includes("folder")) return true;
    const img = row.querySelector('img[alt*="フォルダ"], img[alt*="older"]');
    if (img) return true;
    if (name && !/\.[a-zA-Z0-9]{1,8}$/.test(name)) return true;
    return false;
  }

  function getSelectedRow() {
    const candidates = [
      '[role="row"][aria-selected="true"]',
      '[data-id][aria-selected="true"]',
      '[aria-selected="true"][data-target]',
    ];
    for (const sel of candidates) {
      const r = document.querySelector(sel);
      if (r) return r;
    }
    return null;
  }

  // 同期版: 行情報のみ (breadcrumbs は呼び出し側で別途取得)
  function getSelectedTargetSync() {
    const row = getSelectedRow();
    if (row) {
      const name = extractRowName(row);
      if (name) {
        const isFolder = looksLikeFolder(row, name);
        return { kind: isFolder ? "folder" : "file", name };
      }
    }
    return { kind: "current" };
  }

  // ----------------------------------------------------------------------
  // フォルダ情報サブメニュー検出
  // ----------------------------------------------------------------------
  function isFolderInfoSubmenu(menuRoot) {
    if (!menuRoot) return false;
    let text = "";
    if (menuRoot.querySelectorAll) {
      const items = menuRoot.querySelectorAll('[role="menuitem"]');
      if (items && items.length >= 2) {
        items.forEach((it) => (text += (it.innerText || it.textContent || "") + "\n"));
      }
    }
    if (!text) {
      text = (menuRoot.innerText || "").trim();
      if (!text || text.length > 600) return false;
    }
    const hasDetail = text.includes("詳細") || /\bDetails?\b/i.test(text);
    const hasActivityOrSearch =
      text.includes("アクティビティ") ||
      /内を検索/.test(text) ||
      /\bActivity\b/i.test(text) ||
      /Search in/i.test(text);
    return hasDetail && hasActivityOrSearch;
  }

  function collectMenus(node) {
    if (!node || node.nodeType !== 1) return [];
    const out = [];
    if (node.matches && node.matches('[role="menu"]')) out.push(node);
    if (node.querySelectorAll) {
      node.querySelectorAll('[role="menu"]').forEach((el) => out.push(el));
    }
    if (out.length === 0 && node.querySelector && node.querySelector('[role="menuitem"]')) {
      out.push(node);
    }
    return out;
  }

  // ----------------------------------------------------------------------
  // トースト
  // ----------------------------------------------------------------------
  function showToast(message, kind) {
    const t = document.createElement("div");
    let bg = "#222";
    if (kind === "ok") bg = "#1f7a3a";
    else if (kind === "err") bg = "#a52a2a";
    t.style.cssText =
      "position:fixed;bottom:24px;right:24px;z-index:2147483647;" +
      "background:" + bg + ";color:#fff;padding:12px 16px;border-radius:6px;" +
      "font:13px/1.4 'Segoe UI','Yu Gothic UI',sans-serif;max-width:560px;" +
      "box-shadow:0 4px 16px rgba(0,0,0,0.3);word-break:break-all;";
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => {
      try { t.remove(); } catch (_) {}
    }, 4500);
  }

  // クリップボード書込 (失敗時は手動コピー用ダイアログ)
  async function copyTextWithFallback(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      dlog("clipboard write failed, using fallback", e);
    }
    // フォールバック: モーダルにテキストを出して手動コピー
    showCopyDialog(text);
    return false;
  }

  function showCopyDialog(text) {
    const back = document.createElement("div");
    back.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.6);" +
      "display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#fff;color:#222;padding:20px;border-radius:8px;max-width:640px;" +
      "font:14px/1.5 'Segoe UI','Yu Gothic UI',sans-serif;";
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText =
      "width:100%;height:60px;font:13px/1.4 monospace;box-sizing:border-box;" +
      "padding:6px;border:1px solid #ccc;border-radius:4px;";
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "margin-top:12px;display:flex;gap:8px;justify-content:flex-end;";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "コピー";
    copyBtn.style.cssText =
      "padding:6px 14px;border:1px solid #1a73e8;background:#1a73e8;color:#fff;" +
      "border-radius:4px;cursor:pointer;font:inherit;";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "閉じる";
    closeBtn.style.cssText =
      "padding:6px 14px;border:1px solid #ccc;background:#fafafa;color:#222;" +
      "border-radius:4px;cursor:pointer;font:inherit;";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "✓ コピー完了";
      } catch (_) {
        ta.select();
        document.execCommand("copy");
        copyBtn.textContent = "✓ コピー完了";
      }
    });
    closeBtn.addEventListener("click", () => back.remove());
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });

    box.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">ローカルパス</div>';
    box.appendChild(ta);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(closeBtn);
    box.appendChild(btnRow);
    back.appendChild(box);
    document.body.appendChild(back);
    setTimeout(() => ta.select(), 50);
  }

  // ----------------------------------------------------------------------
  // メニュー注入
  // ----------------------------------------------------------------------
  const INJECT_OPEN_MARKER = "data-dte-injected-open";
  const INJECT_COPY_MARKER = "data-dte-injected-copy";
  const INJECT_ITEMS = [
    { marker: INJECT_OPEN_MARKER, label: "エクスプローラーで開く", action: "open" },
    { marker: INJECT_COPY_MARKER, label: "ローカルパスをコピー", action: "copy" },
  ];

  function injectIntoMenu(menuRoot) {
    if (!menuRoot) return false;
    // すべて注入済みなら skip
    if (
      menuRoot.querySelector(`[${INJECT_OPEN_MARKER}]`) &&
      menuRoot.querySelector(`[${INJECT_COPY_MARKER}]`)
    ) {
      return false;
    }
    let items = Array.from(menuRoot.querySelectorAll('[role="menuitem"]'));
    const enabled = items.filter(
      (el) => el.getAttribute("aria-disabled") !== "true"
    );
    if (enabled.length) items = enabled;

    if (items.length === 0) {
      const all = Array.from(menuRoot.querySelectorAll("*"));
      const seen = new Set();
      for (const el of all) {
        if (el.children.length > 0) continue;
        const t = (el.innerText || el.textContent || "").trim();
        if (t.length < 1 || t.length > 60) continue;
        let p = el.parentElement;
        while (p && p !== menuRoot && p.children.length === 1) p = p.parentElement;
        if (p && !seen.has(p)) {
          seen.add(p);
          items.push(p);
        }
      }
    }
    if (items.length === 0) return false;
    const template = items[items.length - 1];
    if (!template || !template.parentElement) return false;

    let injectedAny = false;
    let prevSibling = template;
    for (const itemDef of INJECT_ITEMS) {
      if (menuRoot.querySelector(`[${itemDef.marker}]`)) continue;
      const clone = template.cloneNode(true);
      clone.setAttribute(itemDef.marker, "1");
      clone.setAttribute("role", "menuitem");
      clone.removeAttribute("aria-disabled");
      clone.style.cursor = "pointer";

      // ラベル差し替え
      const all = clone.querySelectorAll("*");
      let labelEl = null;
      let bestLen = 0;
      all.forEach((el) => {
        if (el.children.length === 0) {
          const t = (el.textContent || "").trim();
          if (t.length > bestLen) {
            bestLen = t.length;
            labelEl = el;
          }
        }
      });
      if (labelEl) labelEl.textContent = itemDef.label;
      else clone.textContent = itemDef.label;

      clone.querySelectorAll('img, svg, [role="img"]').forEach((ic) => {
        try { ic.style.visibility = "hidden"; } catch (_) {}
      });

      const action = itemDef.action;
      const handler = async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation && ev.stopImmediatePropagation();

        const partial = getSelectedTargetSync();

        try {
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          );
          document.body.click();
        } catch (_) {}
        await sleep(80);

        const breadcrumbs = await getFullBreadcrumbs();
        const target = {
          kind: partial.kind,
          name: partial.name,
          breadcrumbs: breadcrumbs || [],
        };
        dlog("clicked", action, "target=", target);

        if (action === "open") {
          try {
            chrome.runtime.sendMessage({ type: "openTarget", target });
          } catch (e) {
            dlog("sendMessage failed", e);
          }
        } else if (action === "copy") {
          chrome.runtime.sendMessage(
            { type: "resolveTargetPath", target },
            async (resp) => {
              if (chrome.runtime.lastError) {
                showToast("拡張通信エラー: " + chrome.runtime.lastError.message, "err");
                return;
              }
              if (!resp || !resp.ok || !resp.path) {
                showToast(
                  "パス解決失敗: " + ((resp && resp.error) || "不明なエラー"),
                  "err"
                );
                return;
              }
              const ok = await copyTextWithFallback(resp.path);
              if (ok) {
                const tag = resp.warning ? " (存在未確認)" : "";
                showToast("コピーしました" + tag + ": " + resp.path, "ok");
              }
            }
          );
        }
      };
      clone.addEventListener("mousedown", handler, true);
      clone.addEventListener("click", handler, true);

      prevSibling.insertAdjacentElement("afterend", clone);
      prevSibling = clone;
      injectedAny = true;
    }
    if (injectedAny) dlog("injected items");
    return injectedAny;
  }

  // ----------------------------------------------------------------------
  // 監視
  // ----------------------------------------------------------------------
  function isFullyInjected(menu) {
    return (
      menu.querySelector(`[${INJECT_OPEN_MARKER}]`) &&
      menu.querySelector(`[${INJECT_COPY_MARKER}]`)
    );
  }

  function tryInjectAll() {
    const menus = document.querySelectorAll('[role="menu"]');
    for (const menu of menus) {
      if (isFullyInjected(menu)) continue;
      if (!isFolderInfoSubmenu(menu)) continue;
      injectIntoMenu(menu);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!node || node.nodeType !== 1) continue;
        const menus = collectMenus(node);
        for (const menu of menus) {
          if (isFullyInjected(menu)) continue;
          if (!isFolderInfoSubmenu(menu)) continue;
          injectIntoMenu(menu);
        }
      }
      if (m.target && m.target.nodeType === 1) {
        const menu = m.target.closest && m.target.closest('[role="menu"]');
        if (menu && !isFullyInjected(menu) && isFolderInfoSubmenu(menu)) {
          injectIntoMenu(menu);
        }
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false,
  });

  // ユーザー操作時に1回だけ走査 (ポーリングは廃止)
  const onUserGesture = () => {
    setTimeout(tryInjectAll, 0);
    setTimeout(tryInjectAll, 80);
    setTimeout(tryInjectAll, 200);
  };
  document.addEventListener("mousedown", onUserGesture, true);
  document.addEventListener("contextmenu", onUserGesture, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key && (ev.key.startsWith("Arrow") || ev.key === "Enter")) {
      onUserGesture();
    }
  }, true);

  // ----------------------------------------------------------------------
  // background からのメッセージ
  // ----------------------------------------------------------------------
  // ----------------------------------------------------------------------
  // popup から user activation 付きで呼び出されるパス取得経路
  // (popup は chrome.scripting.executeScript で MAIN world にディスパッチ関数を流し込む。
  //  ここ (isolated world content script) は CustomEvent で受信し、
  //  readPathViaShowPath を実行して結果を CustomEvent で返す)
  // ----------------------------------------------------------------------
  window.addEventListener("__DTE_FETCH_PATH__", async () => {
    let result = null;
    try {
      const d = await getFullBreadcrumbsDetailed();
      const driveRef = getDriveRefFromUrl();
      result = {
        breadcrumbs: d.breadcrumbs || [],
        altCandidates: d.altCandidates || [],
        source: d.source,
        folderId: getFolderIdFromUrl(),
        driveRef,
        fileName: driveRef && driveRef.type === "file" ? getCurrentFileName() : null,
        url: location.href,
      };
    } catch (e) {
      result = { breadcrumbs: [], altCandidates: [], error: String(e) };
    }
    try {
      window.dispatchEvent(
        new CustomEvent("__DTE_PATH_RESULT__", { detail: result })
      );
    } catch (_) {}
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "getBreadcrumbs") {
      try {
        const driveRef = getDriveRefFromUrl();
        sendResponse({
          breadcrumbs: extractBreadcrumbs(),
          folderId: getFolderIdFromUrl(),
          driveRef,
          fileName: driveRef && driveRef.type === "file" ? getCurrentFileName() : null,
          url: location.href,
          title: document.title,
        });
      } catch (e) {
        sendResponse({ breadcrumbs: [], error: String(e) });
      }
      return;
    }
    if (msg.type === "getBreadcrumbsFull") {
      (async () => {
        try {
          const d = await getFullBreadcrumbsDetailed();
          const driveRef = getDriveRefFromUrl();
          sendResponse({
            breadcrumbs: d.breadcrumbs || [],
            altCandidates: d.altCandidates || [],
            source: d.source,
            folderId: getFolderIdFromUrl(),
            driveRef,
            fileName: driveRef && driveRef.type === "file" ? getCurrentFileName() : null,
            url: location.href,
            title: document.title,
          });
        } catch (e) {
          sendResponse({ breadcrumbs: [], altCandidates: [], error: String(e) });
        }
      })();
      return true;
    }
  });
})();

// Drive Web 用 content script
// - パンくず取得 (popup / background から呼ばれる)
// - 「フォルダ情報」サブメニューに「エクスプローラーで開く」項目を注入
// - 「パスを表示」ボタンを内部的にクリックして完全なパスを取得

(function () {
  const DEBUG = true;
  const dlog = (...args) => {
    if (DEBUG) console.log("[DTE]", ...args);
  };
  dlog("content script loaded", location.href);

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
    // Drive UI ラベルを除外
    const uiLabels = [
      "マイドライブ", "My Drive",  // ←これは breadcrumb の正当な要素なので含める方針
    ];
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

    // クリック前に既存ノードを記録 (差分検出用)
    const before = new WeakSet();
    document.querySelectorAll("body *").forEach((el) => before.add(el));

    realClick(showBtn);

    // 出現要素を 800ms ポーリングで監視
    let popup = null;
    for (let i = 0; i < 40; i++) {
      await sleep(20);
      // 新たに DOM に追加されて、複数のフォルダ名らしきテキストを含む要素を探す
      // 戦略: 新規追加された要素の中で、最も多くの breadcrumb 候補テキストを含むもの
      let bestEl = null;
      let bestCount = 0;
      const newEls = document.querySelectorAll(
        '[role="menu"], [role="dialog"], [role="tooltip"], [role="listbox"], [role="tree"]'
      );
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

  // document.title から推定 (「<current> - <root> - Google ドライブ」形式)
  function extractBreadcrumbsByTitle() {
    const m = document.title && document.title.match(/^(.+?)\s*[-–]\s*Google/i);
    if (!m || !m[1]) return [];
    const head = m[1].trim();
    // 「TD - 2605_ISJ_ZeppHaneda」のように " - " で区切られている場合は逆順 (root → current)
    const parts = head.split(/\s+[-–]\s+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return parts.reverse(); // 最後が現在フォルダ
    }
    return parts.length === 1 ? [parts[0]] : [];
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

    // 3. title フォールバック
    const titleArr = extractBreadcrumbsByTitle();
    if (titleArr.length) candidates.push(titleArr);

    // 最も階層が深いものを採用
    candidates.sort((a, b) => b.length - a.length);
    const result = (candidates[0] || []).filter((s) => s && s.length < 200);
    dlog("extractBreadcrumbs result=", result);
    return result;
  }

  // 完全なパス取得 (メイン): まず「パスを表示」、ダメならフォールバック
  async function getFullBreadcrumbs() {
    try {
      const full = await readPathViaShowPath();
      if (full && full.length >= 1) return full;
    } catch (e) {
      dlog("readPathViaShowPath threw", e);
    }
    return extractBreadcrumbs();
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
  // メニュー注入
  // ----------------------------------------------------------------------
  const INJECT_MARKER = "data-dte-injected";
  const LABEL = "エクスプローラーで開く";

  function injectIntoMenu(menuRoot) {
    if (!menuRoot || menuRoot.querySelector(`[${INJECT_MARKER}]`)) return false;
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

    const clone = template.cloneNode(true);
    clone.setAttribute(INJECT_MARKER, "1");
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
    if (labelEl) labelEl.textContent = LABEL;
    else clone.textContent = LABEL;

    // アイコン非表示
    clone.querySelectorAll('img, svg, [role="img"]').forEach((ic) => {
      try { ic.style.visibility = "hidden"; } catch (_) {}
    });

    const handler = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation && ev.stopImmediatePropagation();

      // 1. 行情報を即時キャプチャ
      const partial = getSelectedTargetSync();

      // 2. 右クリックメニューを閉じる
      try {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
        document.body.click();
      } catch (_) {}
      await sleep(80);

      // 3. 完全パスを取得
      const breadcrumbs = await getFullBreadcrumbs();

      const target = {
        kind: partial.kind,
        name: partial.name,
        breadcrumbs: breadcrumbs || [],
      };
      dlog("clicked, target=", target);
      try {
        chrome.runtime.sendMessage({ type: "openTarget", target });
      } catch (e) {
        dlog("sendMessage failed", e);
      }
    };
    clone.addEventListener("mousedown", handler, true);
    clone.addEventListener("click", handler, true);

    template.insertAdjacentElement("afterend", clone);
    dlog("injected");
    return true;
  }

  // ----------------------------------------------------------------------
  // 監視
  // ----------------------------------------------------------------------
  function tryInjectAll() {
    const menus = document.querySelectorAll('[role="menu"]');
    for (const menu of menus) {
      if (menu.querySelector(`[${INJECT_MARKER}]`)) continue;
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
          if (menu.querySelector(`[${INJECT_MARKER}]`)) continue;
          if (!isFolderInfoSubmenu(menu)) continue;
          injectIntoMenu(menu);
        }
      }
      if (m.target && m.target.nodeType === 1) {
        const menu = m.target.closest && m.target.closest('[role="menu"]');
        if (menu && !menu.querySelector(`[${INJECT_MARKER}]`) && isFolderInfoSubmenu(menu)) {
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
      const bc = await getFullBreadcrumbs();
      result = {
        breadcrumbs: bc || [],
        folderId: getFolderIdFromUrl(),
        url: location.href,
      };
    } catch (e) {
      result = { breadcrumbs: [], error: String(e) };
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
        sendResponse({
          breadcrumbs: extractBreadcrumbs(),
          folderId: getFolderIdFromUrl(),
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
          const full = await getFullBreadcrumbs();
          sendResponse({
            breadcrumbs: full || [],
            folderId: getFolderIdFromUrl(),
            url: location.href,
            title: document.title,
          });
        } catch (e) {
          sendResponse({ breadcrumbs: [], error: String(e) });
        }
      })();
      return true;
    }
  });
})();

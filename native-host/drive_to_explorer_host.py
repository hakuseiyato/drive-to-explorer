#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Chrome Native Messaging Host: ローカルパスをエクスプローラーで開く。

プロトコル:
  stdin/stdout で 4byte little-endian length + UTF-8 JSON 本文。

リクエスト例:
  {"action": "open",        "path": "G:\\共有ドライブ\\Project_Alpha\\03_Editorial"}
  {"action": "select",      "path": "M:\\..."}
  {"action": "exists",      "path": "M:\\..."}
  {"action": "exists_many", "paths": ["M:\\a", "M:\\b", ...]}
  {"action": "ping"}
  {"action": "detect_roots"}
  {"action": "version_info"}
  {"action": "list_subdirs", "paths": ["I:\\共有ドライブ"]}

レスポンス例:
  {"ok": true}
  {"ok": true, "exists": true}
  {"ok": true, "results": [{"path": "M:\\a", "exists": true}, ...]}
  {"ok": false, "error": "..."}
"""

import json
import logging
import logging.handlers
import os
import re
import struct
import subprocess
import sys
import tempfile
import traceback

LOG_PATH = os.path.join(tempfile.gettempdir(), "drive_to_explorer_host.log")

# ドライブレター始まりの絶対パスのみ許可（相対や UNC は拒否）
_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")

# --- 自動アップデート用パス解決 -------------------------------------------
# このホスト自身の場所から「インストールルート」を逆算する。
#   <install_root>/native-host/drive_to_explorer_host.(exe|py)
#   <install_root>/extension/ ...
# exe (PyInstaller) 起動時は sys.executable、py 起動時は __file__ を基準にする。
if getattr(sys, "frozen", False):
    HOST_FILE = os.path.abspath(sys.executable)
else:
    HOST_FILE = os.path.abspath(__file__)
NATIVE_HOST_DIR = os.path.dirname(HOST_FILE)
INSTALL_ROOT = os.path.dirname(NATIVE_HOST_DIR)
UPDATER_PS1 = os.path.join(NATIVE_HOST_DIR, "updater.ps1")

# 更新作業用の一時領域とステータスファイル（拡張がポーリングで進捗を読む）
UPDATE_DIR = os.path.join(tempfile.gettempdir(), "dte_update")
STATUS_FILE = os.path.join(UPDATE_DIR, "status.json")

# 既定の配布元リポジトリ（拡張から repo が渡らなかった場合のフォールバック）
DEFAULT_REPO = "hakuseiyato/drive-to-explorer"

# CreateProcess フラグ: ウィンドウ非表示で別プロセスグループとして起動。
# stdin/stdout/stderr=DEVNULL + close_fds により親終了後も updater は生存する。
# 注意: DETACHED_PROCESS はコンソール非継承となり powershell -File が走らないため
#       使わない（CREATE_NO_WINDOW と併用すると CreateProcess 自体が失敗する）。
_CREATE_NEW_PROCESS_GROUP = 0x00000200
_CREATE_NO_WINDOW = 0x08000000


def _build_logger() -> logging.Logger:
    """1MB × 3 世代でローテートするロガー。"""
    logger = logging.getLogger("dte_host")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    try:
        handler = logging.handlers.RotatingFileHandler(
            LOG_PATH, maxBytes=1024 * 1024, backupCount=3, encoding="utf-8"
        )
        handler.setFormatter(
            logging.Formatter("[%(asctime)s] %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
        )
        logger.addHandler(handler)
    except Exception:
        # ログ書き込みに失敗してもホスト動作は継続させる
        pass
    return logger


_LOG = _build_logger()


def log(msg: str) -> None:
    try:
        _LOG.info(msg)
    except Exception:
        pass


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    raw = sys.stdin.buffer.read(msg_len)
    return json.loads(raw.decode("utf-8"))


def send_message(obj) -> None:
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def validate_path(path: str) -> str:
    if not isinstance(path, str) or not path:
        raise ValueError("path is empty")
    if not _PATH_RE.match(path):
        raise ValueError("path must start with a drive letter (e.g. M:\\...)")
    # 正規化して `..` 抜けを防ぐ
    normalized = os.path.normpath(path)
    if ".." in normalized.split(os.sep):
        raise ValueError("path must not contain '..'")
    return normalized


def _write_status(state: str, **extra) -> None:
    """更新進捗を status.json に書き出す（拡張がポーリングで読む）。"""
    obj = {"state": state}
    obj.update(extra)
    try:
        os.makedirs(UPDATE_DIR, exist_ok=True)
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
    except Exception:
        log("status write failed: " + traceback.format_exc())


def start_update(repo: str) -> dict:
    """updater.ps1 をデタッチ起動し、即座に応答を返す。

    重い処理（zip DL・展開・ファイル入替）は updater.ps1 側で行う。
    実行中の exe は自分自身を上書きできないため、ホストは起動役に徹し、
    応答後すぐ終了する（exe ハンドルが解放され updater が入替可能になる）。
    """
    if not os.path.isfile(UPDATER_PS1):
        return {"ok": False, "error": f"updater.ps1 が見つかりません: {UPDATER_PS1}"}

    _write_status("starting", repo=repo)

    pid = os.getpid()
    cmd = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-File", UPDATER_PS1,
        "-Repo", repo,
        "-InstallRoot", INSTALL_ROOT,
        "-StatusFile", STATUS_FILE,
        "-HostPid", str(pid),
    ]
    try:
        subprocess.Popen(
            cmd,
            close_fds=True,
            creationflags=_CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=NATIVE_HOST_DIR,
        )
    except Exception as e:
        _write_status("error", error=str(e))
        return {"ok": False, "error": f"updater 起動失敗: {e}"}

    log(f"updater launched (pid={pid}, root={INSTALL_ROOT}, repo={repo})")
    return {"ok": True, "updating": True, "installRoot": INSTALL_ROOT}


def read_update_status() -> dict:
    """updater が書き込んだ進捗を返す。未開始なら state=unknown。

    encoding は utf-8-sig を使う。Windows PowerShell 5.1 の
    `Set-Content -Encoding UTF8` は BOM を付けるため、utf-8 で開くと
    json.load が BOM で失敗し、更新の進捗と完了が拡張側に一切届かなくなる。
    utf-8-sig なら BOM 有無の両方を受け付けられる。
    """
    try:
        with open(STATUS_FILE, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        return {"ok": True, **data}
    except FileNotFoundError:
        return {"ok": True, "state": "unknown"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# Drive for desktop がミラーを作る際に必ず生成する目印フォルダ名
# (日本語 UI / 英語 UI の両方。どれか 1 つでもあればルート候補とみなす)
_DRIVE_MARKERS = ("マイドライブ", "My Drive", "共有ドライブ", "Shared drives")


def _markers_in(base: str):
    """base 直下に存在する Drive for desktop の目印フォルダ名を返す。"""
    found = []
    for name in _DRIVE_MARKERS:
        try:
            if os.path.isdir(os.path.join(base, name)):
                found.append(name)
        except Exception:
            # アクセス拒否・切断されたネットワークドライブ等は無視して次へ
            pass
    return found


def _existing_drive_roots():
    """実在するドライブレターだけを返す。

    A: 〜 Z: を総当たりで os.path.isdir に掛けると、切断されたネットワーク
    ドライブで Windows のリダイレクタが再接続を試み、数十秒ブロックする。
    ホストのリクエストループは同期なのでその間ホスト全体が停止してしまう。
    GetLogicalDrives のビットマスクで実在するものだけに絞る。
    """
    try:
        import ctypes

        # ハードエラーダイアログ (「ドライブにディスクがありません」等) を抑止
        ctypes.windll.kernel32.SetErrorMode(0x0001)  # SEM_FAILCRITICALERRORS
        mask = ctypes.windll.kernel32.GetLogicalDrives()
    except Exception:
        # 非 Windows / ctypes 不可の環境では総当たりにフォールバック
        return ["{0}:\\".format(chr(c)) for c in range(ord("A"), ord("Z") + 1)]
    roots = []
    for i in range(26):
        if mask & (1 << i):
            roots.append("{0}:\\".format(chr(ord("A") + i)))
    return roots


def detect_roots() -> dict:
    """Drive for desktop のミラールート候補を自動検出する。

    走査対象:
      1. 実在するドライブレターの直下 … 「ドライブレターにマウント」設定
      2. %USERPROFILE% 直下           … 「フォルダにマウント」設定
    目印フォルダ (マイドライブ / 共有ドライブ / 英語版) を 1 つでも持つ場所を候補とする。
    """
    candidates = _existing_drive_roots()
    profile = os.environ.get("USERPROFILE")
    if profile:
        candidates.append(profile)

    roots = []
    seen = set()
    for base in candidates:
        key = os.path.normpath(base).lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            if not os.path.isdir(base):
                continue
        except Exception:
            continue
        markers = _markers_in(base)
        if markers:
            roots.append({"path": base, "markers": markers})
    return {"ok": True, "roots": roots}


def version_info() -> dict:
    """ホストが属するインストールルートと、そこに置かれた拡張のバージョンを返す。

    ブラウザに読み込まれている拡張が「どのフォルダのものか」は拡張側から
    知る術がない。一方このホストは自身のファイル位置から INSTALL_ROOT を
    逆算できるので、そこの extension/manifest.json の version を返す。
    拡張側 (options) が chrome.runtime.getManifest().version と比較すれば、
    別フォルダの古い拡張を読み込んでいる状態を検出できる。
    """
    ext_manifest = os.path.join(INSTALL_ROOT, "extension", "manifest.json")
    version = None
    error = None
    try:
        with open(ext_manifest, "r", encoding="utf-8") as f:
            version = json.load(f).get("version")
    except Exception as e:
        error = str(e)
    return {
        "ok": True,
        "installRoot": INSTALL_ROOT,
        "hostFile": HOST_FILE,
        "extensionManifest": ext_manifest,
        "extensionVersionOnDisk": version,
        "error": error,
    }


# Drive for desktop はボリュームラベルを "<email> - Google Drive" にする。
# FAT32 のラベル長制限で末尾は "..." に切られるため、" - " の手前だけを見る。
# email 自体が長く " - " まで届かず切れた場合は一致させない（誤った email を返さない）。
_LABEL_EMAIL_RE = re.compile(r"^\s*([^\s@]+@[^\s]+?)\s+-\s")


def volume_email(path) -> dict:
    """path が属するドライブのボリュームラベルから、持ち主の Google アカウントを返す。

    複数アカウントを Drive for desktop でマウントしていると、ドライブレターごとに
    アカウントが違う。エクスプローラー → Drive で正しいアカウントを開くために使う。
    特定できなければ email=None（呼び出し側は従来どおりの挙動にフォールバック）。
    """
    np = validate_path(path)
    root = np[:3]
    label = ""
    try:
        import ctypes

        buf = ctypes.create_unicode_buffer(261)
        if ctypes.windll.kernel32.GetVolumeInformationW(
            root, buf, len(buf), None, None, None, None, 0
        ):
            label = buf.value
    except Exception:
        log("volume_email: GetVolumeInformationW failed: " + traceback.format_exc())
    m = _LABEL_EMAIL_RE.match(label)
    return {"ok": True, "root": root, "label": label, "email": m.group(1) if m else None}


# 最小の動作チェック（ラベル解析のみ）
assert _LABEL_EMAIL_RE.match("user@example.com - Googl...").group(1) == "user@example.com"
assert _LABEL_EMAIL_RE.match("Google Drive") is None
assert _LABEL_EMAIL_RE.match("very.long.name@example-company.co") is None


def list_subdirs(paths) -> dict:
    r"""指定パス直下のサブディレクトリ名を列挙する。

    共有ドライブ名は drives.get スコープ制約で API から取れないことがある。
    その場合に <root>\共有ドライブ\* を列挙して候補を組み立てるために使う。
    存在しないパスは dirs=[] を返す（エラーにしない）。
    """
    if not isinstance(paths, list):
        return {"ok": False, "error": "paths must be an array"}
    results = []
    for raw in paths:
        entry = {"path": raw, "dirs": []}
        try:
            np = validate_path(raw)
            entry["path"] = np
            if os.path.isdir(np):
                with os.scandir(np) as it:
                    for e in it:
                        try:
                            if e.is_dir():
                                entry["dirs"].append(e.name)
                        except OSError:
                            # 個別エントリのアクセス失敗は無視して次へ
                            pass
        except Exception as e:
            entry["error"] = str(e)
        results.append(entry)
    return {"ok": True, "results": results}


def handle(req: dict) -> dict:
    action = req.get("action")

    # ping は path 不要 (生存確認用)。version も返してUI側で参照可能にする。
    if action == "ping":
        return {"ok": True, "pong": True}

    # --- 自動アップデート（path 不要） ---
    if action == "update":
        repo = req.get("repo") or DEFAULT_REPO
        return start_update(repo)

    if action == "update_status":
        return read_update_status()

    # インストール構成の自己申告（path 不要）
    if action == "version_info":
        return version_info()

    # 指定パス直下のサブディレクトリ列挙（単一 path 不要）
    if action == "list_subdirs":
        return list_subdirs(req.get("paths") or [])

    # ローカルルート自動検出（path 不要）
    if action == "detect_roots":
        return detect_roots()

    # ドライブのボリュームラベルから持ち主の Google アカウントを取得
    if action == "volume_email":
        return volume_email(req.get("path", ""))

    if action == "exists_many":
        # 複数パスの存在を 1 リクエストで一括チェック (IPC 往復削減)
        paths = req.get("paths") or []
        if not isinstance(paths, list):
            return {"ok": False, "error": "paths must be an array"}
        results = []
        for p in paths:
            try:
                np = validate_path(p)
                results.append({"path": np, "exists": os.path.exists(np)})
            except Exception as e:
                results.append({"path": p, "exists": False, "error": str(e)})
        return {"ok": True, "results": results}

    path = validate_path(req.get("path", ""))

    if action == "exists":
        return {"ok": True, "exists": os.path.exists(path)}

    if action == "open":
        if not os.path.exists(path):
            return {"ok": False, "error": f"path not found: {path}"}
        subprocess.Popen(["explorer.exe", path], close_fds=True)
        return {"ok": True}

    if action == "select":
        # ファイルを選択状態でエクスプローラーを開く。
        # ファイル本体が存在しなければ親フォルダを開くフォールバック。
        if os.path.exists(path):
            # 配列形式で /select, とパスを渡す (open との一貫性、shell 文字列形式廃止)
            subprocess.Popen(["explorer.exe", "/select,", path], close_fds=True)
            return {"ok": True}
        parent = os.path.dirname(path)
        if os.path.exists(parent):
            subprocess.Popen(["explorer.exe", parent], close_fds=True)
            return {"ok": True, "fallback": "parent"}
        return {"ok": False, "error": f"path not found: {path}"}

    return {"ok": False, "error": f"unknown action: {action}"}


def main() -> None:
    log("host started")
    try:
        while True:
            msg = read_message()
            if msg is None:
                log("stdin closed")
                break
            log(f"req: {msg}")
            try:
                resp = handle(msg)
            except Exception as e:
                resp = {"ok": False, "error": str(e)}
                log("error: " + traceback.format_exc())
            send_message(resp)
            if resp.get("updating"):
                log("exiting to release exe lock for updater")
                break
    except Exception:
        log("fatal: " + traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()

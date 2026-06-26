#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Chrome Native Messaging Host: ローカルパスをエクスプローラーで開く。

プロトコル:
  stdin/stdout で 4byte little-endian length + UTF-8 JSON 本文。

リクエスト例:
  {"action": "open",        "path": "M:\\案件\\ISJ_2605\\Live"}
  {"action": "select",      "path": "M:\\..."}
  {"action": "exists",      "path": "M:\\..."}
  {"action": "exists_many", "paths": ["M:\\a", "M:\\b", ...]}
  {"action": "ping"}

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
    """updater が書き込んだ進捗を返す。未開始なら state=unknown。"""
    try:
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {"ok": True, **data}
    except FileNotFoundError:
        return {"ok": True, "state": "unknown"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


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
    except Exception:
        log("fatal: " + traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()

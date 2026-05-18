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


def handle(req: dict) -> dict:
    action = req.get("action")

    # ping は path 不要 (生存確認用)
    if action == "ping":
        return {"ok": True, "pong": True}

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

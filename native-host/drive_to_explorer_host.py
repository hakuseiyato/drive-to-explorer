#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Chrome Native Messaging Host: ローカルパスをエクスプローラーで開く。

プロトコル:
  stdin/stdout で 4byte little-endian length + UTF-8 JSON 本文。

リクエスト例:
  {"action": "open",   "path": "M:\\案件\\ISJ_2605\\Live"}
  {"action": "exists", "path": "M:\\..."}

レスポンス例:
  {"ok": true}
  {"ok": false, "error": "..."}
"""

import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime

LOG_PATH = os.path.join(tempfile.gettempdir(), "drive_to_explorer_host.log")

# ドライブレター始まりの絶対パスのみ許可（相対や UNC は拒否）
_PATH_RE = re.compile(r"^[A-Za-z]:[\\/]")


def log(msg: str) -> None:
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}\n")
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
            subprocess.Popen(f'explorer.exe /select,"{path}"', close_fds=True)
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

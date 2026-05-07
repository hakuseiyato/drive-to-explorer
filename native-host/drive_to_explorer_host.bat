@echo off
REM Chrome Native Messaging Host ラッパー
REM Chrome は stdin/stdout でこの bat と通信するため、余計な出力を出さないこと。

setlocal
set "SCRIPT_DIR=%~dp0"

REM Python ランチャー優先、無ければ python を試す
where py >nul 2>&1
if %errorlevel%==0 (
    py -3 "%SCRIPT_DIR%drive_to_explorer_host.py"
) else (
    python "%SCRIPT_DIR%drive_to_explorer_host.py"
)

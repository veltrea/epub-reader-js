#!/usr/bin/env bash
# =============================================================================
# tb-windows.sh — Windows で動いているアプリを、Mac から操作する
#
# なぜ MCP の tb_* が使えないか
#   `mcp/testbus-mcp/server.mjs` は自分で HTTP サーバーを立てて、アプリが
#   `/pull` に取りに来るのを待つ。Mac で動かしている中継役に、Windows のアプリは
#   つながらない（別の機械なので 127.0.0.1 が違う）。**そこで中継役ごと Windows で動かす。**
#   `mssh` は ssh のポート転送(-R)を渡す口を持たないので、転送でつなぐ手も使えない。
#
# 2 つの起動のしかたが要る理由（実測。2026-08-30）
#   - 中継役(node): **SSH の接続を張りっぱなしにして生かす。** `Start-Process` で
#     切り離すと、SSH セッションが終わった瞬間に一緒に終わる。
#   - アプリ(GUI): **schtasks で、ログオン中のユーザーのセッションで起動する。**
#     SSH の非対話セッションには対話的なデスクトップが無く、WebView2 がウィンドウを
#     作れずに待ち続ける（プロセスは生きるが 25MB のまま、testbus にもつながらない）。
#
# 使い方
#   scripts/tb-windows.sh start           中継役とアプリを起動する
#   scripts/tb-windows.sh status          つながっているか見る
#   scripts/tb-windows.sh stop            両方を止める
#   scripts/tb-windows.sh <命令> [JSON]   命令を 1 つ送り、結果の JSON を出す
#   scripts/tb-windows.sh test            **Windows の中で** smoke を走らせる
#
#   試験は Windows の中で走らせる（cmd_test のコメントに理由がある）:
#     scripts/tb-windows.sh start
#     scripts/tb-windows.sh test
#
#   例:
#     scripts/tb-windows.sh ping
#     scripts/tb-windows.sh state
#     scripts/tb-windows.sh open '{"id":"vertical-long"}'
#     scripts/tb-windows.sh eval '{"js":"return document.title"}'
#
# 前提
#   - `scripts/xbuild-windows.sh` を 1 回通してあること（送ったソースと .exe を使う）
# =============================================================================
set -euo pipefail

MACHINE="work1v"
REMOTE_DIR="epubxbuild"
TASK_NAME="EpubReaderTestbus"
REMOTE_USER="veltrea"          # ログオンしている作業用アカウント
MSSH="${MSSH:-$HOME/.claude/bin/mssh}"
PORT=47832

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
PIDFILE="$REPO_ROOT/dist/windows/.tb-bridge.pid"
LOGFILE="$REPO_ROOT/dist/windows/tb-bridge.log"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# PowerShell へ文字列を安全に渡す。**引用符をそのまま埋め込まない。**
# JSON には `"` が必ず入るので、素直に書くと cmd と PowerShell の両方で壊れる。
# base64 にして渡し、向こうで戻す。日本語もこれで壊れない。
ps_with_json() {
  local json="$1" script="$2"
  local b64
  b64="$(printf '%s' "$json" | base64 | tr -d '\n')"
  "$MSSH" "$MACHINE" --ps "\$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')); $script"
}

health() {
  "$MSSH" "$MACHINE" --ps "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:$PORT/health' -UseBasicParsing -TimeoutSec 5).Content } catch { 'DOWN' }" 2>/dev/null | tr -d '\r'
}

cmd_start() {
  # --- 中継役 ---
  if health | grep -q '"ok":true'; then
    ok "中継役は既に動いている"
  else
    say "中継役を起動する（SSH を張りっぱなしにして生かす）"
    mkdir -p "$(dirname "$PIDFILE")"
    nohup "$MSSH" "$MACHINE" "cd /d %USERPROFILE%\\$REMOTE_DIR && node mcp\\testbus-mcp\\server.mjs" \
      > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    local up=0 i
    for i in $(seq 1 15); do
      sleep 1
      if health | grep -q '"ok":true'; then up=1; break; fi
    done
    [ "$up" = "1" ] || die "中継役が上がりませんでした（記録: $LOGFILE）"
    ok "中継役が動いた"
  fi

  # --- アプリ ---
  say "アプリを起動する（schtasks でログオン中のセッションへ）"
  local bat='C:\Windows\Temp\epub-testbus.bat'
  "$MSSH" "$MACHINE" --ps "
Set-Content -Path '$bat' -Encoding ASCII -Value @(
  '@echo off',
  'set EPUB_READER_TESTBUS=1',
  'start \"\" \"%USERPROFILE%\\$REMOTE_DIR\\src-tauri\\target\\release\\epub-reader.exe\"'
)
schtasks /Create /TN $TASK_NAME /TR '$bat' /SC ONCE /ST 00:00 /RU $REMOTE_USER /IT /F | Out-Null
schtasks /Run /TN $TASK_NAME | Out-Null
'ok'" >/dev/null 2>&1 || die "アプリを起動できませんでした"

  local conn=0 i
  for i in $(seq 1 20); do
    sleep 2
    if health | grep -q '"appConnected":true'; then conn=1; break; fi
  done
  [ "$conn" = "1" ] || die "アプリが中継役につながりませんでした（health: $(health)）"
  ok "アプリがつながった"
}

cmd_stop() {
  say "アプリを止める"
  "$MSSH" "$MACHINE" --ps "
Get-Process epub-reader -ErrorAction SilentlyContinue | Stop-Process -Force
schtasks /Delete /TN $TASK_NAME /F 2>\$null | Out-Null
'ok'" >/dev/null 2>&1 || true

  say "中継役を止める"
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  # SSH を切っても向こうの node が残ることがあるので、名指しでも止める
  "$MSSH" "$MACHINE" --ps "
Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
  Where-Object { \$_.CommandLine -like '*testbus-mcp*' } |
  ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }
'ok'" >/dev/null 2>&1 || true
  ok "止めた"
}

# **Windows の中で試験を走らせる。**
#
# **なぜ「中で」走らせるか:** `tests/smoke.mjs` は testbus へ HTTP で話しかける。
# testbus は Windows の 127.0.0.1 で待っているので、Mac からは直接届かない。
# 手元から届かせるには SSH のポート転送が要るが、**`mssh` はそのオプションを渡す口を
# 持たない**し、接続先の値を直に読むのは方針で禁じられている（実際にフックに止められた）。
# **Windows の中で走らせれば、その問題ごと消える。** 向こうには Node が入っている。
cmd_test() {
  local script="${1:-tests/smoke.mjs}"
  local win_script="${script//\//\\}"
  say "Windows の中で $script を走らせる"
  # **ルビのある本を使う。** 既定の本にはルビが無く、S4（ルビの読みを本文から除く）が
  # 飛ばされて 32 件で終わる。33 件そろえるにはこの本が要る（HANDOVER §12 に経緯がある）。
  "$MSSH" "$MACHINE" "cd /d %USERPROFILE%\\$REMOTE_DIR && set TB_EPUB=test-books\\ruby-vertical.epub&& set TB_EPUB_TITLE=ルビ・縦中横・圏点の見本&& node $win_script"
}

cmd_status() {
  local h; h="$(health)"
  if [ "$h" = "DOWN" ]; then
    err "中継役が動いていない（scripts/tb-windows.sh start）"
    exit 1
  fi
  printf '%s\n' "$h"
}

# 命令を 1 つ送り、返ってきた JSON をそのまま出す
cmd_send() {
  # 既定値を直に書かない。`${2:-{\}}` と書くと、スクリプトの中では `\}` が
  # そのまま文字として残り、送る JSON が `"args":{\}` の形に壊れる（2026-08-30 に実測）。
  local empty='{}'
  local name="$1" args="${2:-$empty}"
  local body="{\"cmd\":\"$name\",\"args\":$args}"
  # 送る中身を見たいとき: TB_DEBUG=1 scripts/tb-windows.sh ...
  [ -n "${TB_DEBUG:-}" ] && printf '送る JSON: %s\n' "$body" >&2
  # **-Body は文字列で渡すこと。** バイト配列で渡すと中継役が 400（bad json）を返す
  # （2026-08-30 に実測）。charset=utf-8 を付ければ、文字列でも日本語は壊れない。
  # 返りは RawContentStream から UTF-8 で読む。Content をそのまま使うと日本語が化ける。
  ps_with_json "$body" "
try {
  \$r = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:$PORT/cmd' -ContentType 'application/json; charset=utf-8' -Body \$json -TimeoutSec 120 -UseBasicParsing
  [Text.Encoding]::UTF8.GetString(\$r.RawContentStream.ToArray())
} catch { '{\"ok\":false,\"error\":\"' + \$_.Exception.Message + '\"}' }"
}

case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  test)   shift; cmd_test "$@" ;;
  "")     die "使い方: scripts/tb-windows.sh {start|stop|status|test|<命令> [JSON]}" ;;
  # **"${2:-}" と書かないこと。** 引数が無いときに空文字を渡してしまい、
  # cmd_send 側の既定値（{}）が使われず、送る JSON が `"args":}` の形に壊れる。
  *)      cmd_send "$@" ;;
esac

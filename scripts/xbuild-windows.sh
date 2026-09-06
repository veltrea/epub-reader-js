#!/usr/bin/env bash
# =============================================================================
# xbuild-windows.sh — Mac から 1 コマンドで Windows 版を作る
#
# なぜこれが要るか
#   別の機械でビルドすると「向こうで直して、手元に持ち帰り忘れる」が必ず起きる。
#   数日後に手元のソースではビルドが通らず、配布物も古いまま、という事故を
#   実際に繰り返してきた（CLAUDE.md に記録がある）。
#
#   このスクリプトは、忘れる余地のある人の手順を無くす:
#
#     1. 手元（Mac）の作業コピーが唯一の正本
#     2. 毎回、**まっさらな**リモートの場所へ送る（古いコピーが残らない）
#     3. Windows 機は**コンパイルするだけ**。直す場所ではない
#     4. 成果物を持ち帰り、**sha256 を両端で照合**する。食い違えば止まる
#     5. 照合の通ったものだけを dist/windows/ に置く
#
#   ビルドが失敗したら、**手元のソースを直して**やり直すこと。
#   Windows 側のコピーを直してはいけない——それがこのスクリプトの防いでいる事故。
#
# 使い方
#   scripts/xbuild-windows.sh              # dist/windows/ に .exe を置く
#   scripts/xbuild-windows.sh --debug      # デバッグビルド（速いが大きい）
#   scripts/xbuild-windows.sh --installer  # 加えてインストーラも作る（tauri-cli が要る）
#
# 前提
#   - ~/.claude/bin/mssh（または $MSSH）で "work1v" に届くこと
#     （work1v = 作業用アカウント。%USERPROFILE% がそのまま使える）
#   - Windows 機に Rust / MSVC / Windows SDK / WebView2 が入っていること
#     （足りなければこのスクリプトが教える）
#   - 寝ていれば ~/.claude/bin/wake で起こしてから始める
# =============================================================================
set -euo pipefail

# src-tauri/Cargo.toml の [package] name と一致していること（.exe の名前はこれで決まる）
APP_NAME="epub-reader"
MACHINE="work1v"
REMOTE_DIR="epubxbuild"                  # 毎回消して作り直すリモートの作業場所
MSSH="${MSSH:-$HOME/.claude/bin/mssh}"
WAKE="${WAKE:-$HOME/.claude/bin/wake}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[ -x "$MSSH" ] || command -v "$MSSH" >/dev/null 2>&1 \
  || die "mssh が見つかりません: $MSSH（\$MSSH で指定できます）"

PROFILE="release"
CARGO_FLAG="--release"
INSTALLER=0
for arg in "$@"; do
  case "$arg" in
    --debug)     PROFILE="debug"; CARGO_FLAG="" ;;
    --installer) INSTALLER=1 ;;
    *) die "知らない引数: $arg（--debug / --installer）" ;;
  esac
done

# --- 0. Windows 機が起きているか -------------------------------------------
say "Windows 機（$MACHINE）に届くか確認"
if ! "$MSSH" "$MACHINE" "echo ok" >/dev/null 2>&1; then
  err "応答がありません。起こします"
  if [ -x "$WAKE" ]; then
    "$WAKE" work1 || true
  else
    err "wake が見つかりません: $WAKE"
  fi
  # 起動には実測で 45〜60 秒かかる。10 秒おきに 12 回まで試す
  woke=0
  for _ in $(seq 1 12); do
    sleep 10
    if "$MSSH" "$MACHINE" "echo ok" >/dev/null 2>&1; then woke=1; break; fi
  done
  [ "$woke" = "1" ] || die "Windows 機が起きませんでした。手で電源を入れてから、もう一度実行してください"
fi
ok "届いた"

# --- 1. リモートの道具が揃っているか ----------------------------------------
say "ビルドに要るものを確認"
MISSING="$("$MSSH" "$MACHINE" '
  where /q cargo || echo cargo
  where /q rustc || echo rustc
' 2>/dev/null | tr -d '\r' | grep -v '^$' || true)"

if [ "$INSTALLER" = "1" ]; then
  if ! "$MSSH" "$MACHINE" "cargo tauri --version" >/dev/null 2>&1; then
    MISSING="$MISSING
tauri-cli"
  fi
fi

MISSING="$(printf '%s' "$MISSING" | grep -v '^$' || true)"
if [ -n "$MISSING" ]; then
  err "Windows 機に足りないものがあります:"
  printf '%s\n' "$MISSING" | sed 's/^/    - /'
  cat >&2 <<HINT

  次を Windows 機で実行してください（$MSSH $MACHINE '...' でも可）:
    rustup default stable-x86_64-pc-windows-msvc
    cargo install tauri-cli --version "^2" --locked
HINT
  exit 1
fi
ok "道具は揃っている"

# --- 2. まっさらなリモートへ送る --------------------------------------------
say "リモートの作業場所を作り直す（古いコピーを残さない）"
"$MSSH" "$MACHINE" "if exist %USERPROFILE%\\$REMOTE_DIR rmdir /s /q %USERPROFILE%\\$REMOTE_DIR" >/dev/null 2>&1 || true
"$MSSH" "$MACHINE" "mkdir %USERPROFILE%\\$REMOTE_DIR" >/dev/null 2>&1 || true

say "ソースを送る"
PAYLOAD="$(mktemp -t epubxbuild).tgz"
# 送るもの:
#   src/        フロント。tauri.conf.json の frontendDist が "../src" を指す
#   src-tauri/  Rust 側。target は除く（送ると古い結果が混ざる）
#   test-books/ 実機での確認に使うサンプルの本（2MB ほど）
#   mcp/        テストバスの中継役。Windows 実機を Mac から操作するのに要る
#   tests/      試験一式。**Windows の中で走らせる**ので送る（下を読む）
#
# **COPYFILE_DISABLE=1 は必須。** 付けないと macOS の tar が拡張属性を
# `._foo.json` という別のファイルとして一緒に固め、Windows 側でそれが本物の
# ファイルとして展開される。Tauri は `capabilities/` の中身を全部読むので、
# `._default.json` を JSON として読もうとして「valid UTF-8 でない」で失敗する。
COPYFILE_DISABLE=1 tar czf "$PAYLOAD" \
  --exclude='target' \
  --exclude='.git' \
  --exclude='.DS_Store' \
  src src-tauri test-books mcp tests \
  || die "ソースをまとめられませんでした"

# scp は `%USERPROFILE%` を展開しない。相対パス（ホーム基準）で渡す
"$MSSH" put "$MACHINE" "$PAYLOAD" "$REMOTE_DIR/payload.tgz" >/dev/null \
  || die "ソースを送れませんでした"
rm -f "$PAYLOAD"
"$MSSH" "$MACHINE" "cd /d %USERPROFILE%\\$REMOTE_DIR && tar xzf payload.tgz" >/dev/null \
  || die "リモートで展開できませんでした"
ok "送信と展開が終わった"

# --- 3. リモートでビルド ----------------------------------------------------
mkdir -p dist/windows
LOG="dist/windows/build.log"
say "Windows 機でビルド（$PROFILE）— 記録は $LOG"
set +e
if [ "$INSTALLER" = "1" ]; then
  # **作るものを明示する。** tauri.conf.json の `bundle.targets` は "all" だが、
  # そこに頼ると設定を変えた人が意図せず別のものを作ってしまう。
  # scripts/package-macos.sh も同じ理由で `--bundles app` と明示している。
  BUILD_CMD="cargo tauri build --bundles nsis,msi"
  [ "$PROFILE" = "debug" ] && BUILD_CMD="cargo tauri build --debug --bundles nsis,msi"
else
  BUILD_CMD="cargo build $CARGO_FLAG"
fi
"$MSSH" "$MACHINE" "cd /d %USERPROFILE%\\$REMOTE_DIR\\src-tauri && $BUILD_CMD" 2>&1 | tee "$LOG"
BUILD_STATUS=${PIPESTATUS[0]}
set -e
[ "$BUILD_STATUS" -eq 0 ] \
  || die "ビルドに失敗しました（記録: $LOG）。**手元のソースを直して**やり直してください（Windows 側を直さないこと）"
ok "ビルドが通った"

# --- 4. 持ち帰って照合 ------------------------------------------------------
# リモートの 1 ファイルを持ち帰り、sha256 を両端で照合する。
# 引数は「ホームからの相対パス（/ 区切り）」と「手元の置き場所」
pull_verified() {
  local remote="$1" local_path="$2"
  local win="${remote//\//\\}"

  # set -e の下では代入の中の失敗が黙って無視される（die の文言すら出ない）ので、
  # いったん受け取ってから中身を見る
  set +e
  local rh
  rh="$("$MSSH" "$MACHINE" "certutil -hashfile %USERPROFILE%\\$win SHA256" \
    | tr -d '\r' | sed -n '2p' | tr -d ' ' | tr 'A-F' 'a-f')"
  set -e

  # certutil は失敗したときもエラーの文を出す。「空でない」だけでは検査にならず、
  # エラーの文の 2 行目をハッシュとして受け取ってしまう。64 桁の 16 進まで見る
  case "$rh" in
    ????????????????????????????????????????????????????????????????) ;;
    *) die "リモートに $remote がありません（ビルドは通ったのに成果物が無い）" ;;
  esac

  "$MSSH" get "$MACHINE" "$remote" "$local_path" >/dev/null \
    || die "$remote を持ち帰れませんでした"

  local lh
  lh="$(shasum -a 256 "$local_path" | awk '{print $1}')"
  if [ "$rh" != "$lh" ]; then
    err "sha256 が食い違います（転送で壊れた可能性）: $remote"
    err "  リモート: $rh"
    err "  手元    : $lh"
    rm -f "$local_path"
    exit 1
  fi
  ok "照合 ok  $(basename "$local_path")  $lh"
}

EXE_REMOTE="$REMOTE_DIR/src-tauri/target/$PROFILE/$APP_NAME.exe"
LOCAL_EXE="dist/windows/$APP_NAME.exe"

say "本体を持ち帰って照合する"
pull_verified "$EXE_REMOTE" "$LOCAL_EXE"
LOCAL_HASH="$(shasum -a 256 "$LOCAL_EXE" | awk '{print $1}')"

# --- 5. インストーラ --------------------------------------------------------
if [ "$INSTALLER" = "1" ]; then
  say "インストーラを持ち帰って照合する"
  BUNDLE="$REMOTE_DIR/src-tauri/target/$PROFILE/bundle"
  STAGE="$REMOTE_DIR/out"
  # cmd は `/` をスイッチの先頭と解釈するので、cmd に渡すパスは `\` に直す。
  # scp（mssh get）側は逆に `/` のままでよい
  BUNDLE_WIN="${BUNDLE//\//\\}"
  STAGE_WIN="${STAGE//\//\\}"
  "$MSSH" "$MACHINE" "if exist %USERPROFILE%\\$STAGE_WIN rmdir /s /q %USERPROFILE%\\$STAGE_WIN" >/dev/null 2>&1 || true
  "$MSSH" "$MACHINE" "mkdir %USERPROFILE%\\$STAGE_WIN" >/dev/null 2>&1 || true

  found=0
  for kind in msi nsis; do
    names="$("$MSSH" "$MACHINE" "dir /b %USERPROFILE%\\$BUNDLE_WIN\\$kind" 2>/dev/null \
      | tr -d '\r' | grep -Ei '\.(msi|exe)$' || true)"
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      # ファイル名に空白が入ることがある。scp 越しの引用は壊れやすいので、
      # リモートで空白を除いた名前に写してから取る
      safe="$(printf '%s' "$name" | tr ' ' '-')"
      "$MSSH" "$MACHINE" "copy /Y \"%USERPROFILE%\\$BUNDLE_WIN\\$kind\\$name\" \"%USERPROFILE%\\$STAGE_WIN\\$safe\"" >/dev/null \
        || die "$name をリモートで写せませんでした"
      pull_verified "$STAGE/$safe" "dist/windows/$safe"
      found=$((found + 1))
    done <<< "$names"
  done
  [ "$found" -gt 0 ] || die "インストーラが 1 つも見つかりません（bundle が作られていない）"
fi

SIZE="$(du -h "$LOCAL_EXE" | awk '{print $1}')"
echo
ok "完了"
echo "  成果物 : $LOCAL_EXE（$SIZE）"
echo "  sha256 : $LOCAL_HASH"
echo "  記録   : $LOG"
echo "  置き場 : $(ls dist/windows/ | tr '\n' ' ')"

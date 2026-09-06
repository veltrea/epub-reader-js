#!/usr/bin/env bash
# macOS 配布物（ad-hoc 署名済みの .app + dmg + zip）を作り、壊れていないか検証する。
#
# Apple Developer ID（年 $99）を取らない方針なので ad-hoc 署名で配る。ad-hoc でも
# cdHash は署名時に固定されるので、受け取った人が一度権限を許可すれば保持される。
#
# **必ず再署名すること**: Tauri がビルド時に付ける ad-hoc 署名は
#   Sealed Resources=none
# の状態で、`codesign --verify` が
#   "code has no resources but signature indicates they must be present"
# で落ちる。この壊れ方は Finder でのダブルクリック展開でも救われない。
#
# **zip は --norsrc --noextattr を付けること**: 付けないと拡張属性が AppleDouble
# （`Contents/._Info.plist` 等）として zip に入り、受け取った人が `unzip` で展開した
# ときだけ署名シールが壊れる。作った本人は Finder 展開なので気付けない。
#
#   ./scripts/package-macos.sh
#
# 成果物は dist/ に出る。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

APP_NAME="epub-reader"
VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
BUILT="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DIST="dist"
STAGE="$DIST/stage"
APP="$STAGE/${APP_NAME}.app"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---- 0. ビルド番号 ---------------------------------------------------------
# 版番号(0.3.0)は人に向けた説明なので手で上げる。「同じ物を二度出さない」ための連番は
# macOS が元から持っている CFBundleVersion(ビルド番号)に持たせる。詳細は bump-build.sh。
say "ビルド番号を進める"
./scripts/bump-build.sh
BUILD="$(./scripts/bump-build.sh --show)"
BASE="${APP_NAME}-${VERSION}+${BUILD}-macos"
echo "    ${VERSION} (${BUILD})"

# ---- 1. ビルド -------------------------------------------------------------
say "ビルド (cargo tauri build)"
command -v cargo >/dev/null || die "cargo が見つかりません"
(cd src-tauri && cargo tauri build --bundles app) \
  || die "ビルドに失敗しました（cargo install tauri-cli --version '^2' を済ませてありますか）"
[ -d "$BUILT" ] || die "$BUILT がありません"

# ---- 2. 署名 ---------------------------------------------------------------
# 同梱物を全部置き終えてから署名する。いま子バンドルは無いので .app 一発でよいが、
# 将来ヘルパーを足したら**子 → 親**の順で署名すること（親の --deep では
# 壊れた子の署名は置き換わらない）。
say "ad-hoc 署名"
rm -rf "$STAGE" && mkdir -p "$STAGE"
ditto "$BUILT" "$APP"
xattr -cr "$APP"
codesign --sign - --deep --force --timestamp=none "$APP"

codesign --verify "$APP" || die "署名の検証に失敗しました"
# codesign の出力は**一度だけ受け取って変数に入れる**。
# `codesign ... | grep -q` と書くと、grep が見つけた瞬間に受け口を閉じ、
# まだ書いている codesign が異常終了する。set -o pipefail のせいで
# それが失敗と判定され、**署名は成功しているのに止まる**（速さ次第で
# 通ったり通らなかったりする。2026-08-28 に実際に起きた）。
SIGINFO="$(codesign -dv "$APP" 2>&1 || true)"
printf '%s\n' "$SIGINFO" | grep -E 'Identifier|Sealed' || true
printf '%s\n' "$SIGINFO" | grep -q 'Sealed Resources version' \
  || die "リソースが封印されていません（未封印の ad-hoc 署名のまま）"

# ---- 3. 配布物 -------------------------------------------------------------
say "dmg を作る（zip より安全。AppleDouble 混入が起きない）"
rm -f "$DIST/$BASE.dmg"
hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$APP" -ov -format UDZO "$DIST/$BASE.dmg"

say "zip を作る（--norsrc --noextattr 必須）"
rm -f "$DIST/$BASE.zip"
ditto -c -k --keepParent --norsrc --noextattr "$APP" "$DIST/$BASE.zip"

# ---- 4. 検証 ---------------------------------------------------------------
# 最も壊れやすい経路（unzip）で確かめる。ditto だけで確認すると見逃す。
say "検証（unzip 経路）"
V="$(mktemp -d)"
trap 'rm -rf "$V"' EXIT
unzip -q "$DIST/$BASE.zip" -d "$V"
N="$(find "$V" -name '._*' | wc -l | tr -d ' ')"
[ "$N" = "0" ] || die "AppleDouble が $N 個混入しています（--norsrc --noextattr が効いていない）"
codesign --verify "$V/${APP_NAME}.app" || die "unzip 展開後の署名が壊れています"

say "検証（dmg 経路）"
MNT="$(mktemp -d)"
hdiutil attach -quiet -nobrowse -mountpoint "$MNT" "$DIST/$BASE.dmg"
codesign --verify "$MNT/${APP_NAME}.app" || { hdiutil detach -quiet "$MNT"; die "dmg 内の署名が壊れています"; }
hdiutil detach -quiet "$MNT"

say "完成"
shasum -a 256 "$DIST/$BASE.dmg" "$DIST/$BASE.zip"
ls -lh "$DIST/$BASE.dmg" "$DIST/$BASE.zip"
cat <<EOS

配る前に:
  - GitHub Releases に上げたあと、**上げた資産を落とし直して**同じ検証を通すこと
    （ローカルで正しくても、アップロード経路で壊れることがある）
  - 導入手順は README の "Install" を案内する。macOS 15 以降は「右クリック→開く」が
    無くなっているので、システム設定 > プライバシーとセキュリティ の「このまま開く」か
    \`xattr -dr com.apple.quarantine\` を案内する
EOS

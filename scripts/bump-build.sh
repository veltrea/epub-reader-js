#!/usr/bin/env bash
# ビルド番号を 1 つ進めて Info.plist の CFBundleVersion に焼く。
#
# **なぜ版番号と別に持つか**: `0.3.0` のような版番号(CFBundleShortVersionString)は
# 「人に向けた説明」なので、デバッグビルドのたびに動かすと意味が消える。一方 macOS には
# 元から **CFBundleVersion(ビルド番号)** という枠があり、こちらは「同じ版番号でも別の物」を
# 区別するための単調増加の連番で、Apple 自身が増やすことを要求している。
# だから「末尾をビルドごとに増やす」は OSS の作法から外れていない——増やす場所が
# 版番号ではなくビルド番号だ、というだけ。
#
# 効果:
#   - 手元でも「いま動かしているのがどのビルドか」が一意に分かる(0.3.0 (42) と出る)
#   - 同じ版番号の成果物を二度公開してしまう事故が起きない
#   - デバッグ用に焼いた物も連番に含まれるので、取り違えに気付ける
#
# 使い方:
#   scripts/bump-build.sh          # 1 つ進める(build-release.sh から自動で呼ばれる)
#   scripts/bump-build.sh --show   # 進めずに現在値だけ表示
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COUNTER="$ROOT/src-tauri/build-number"
PLIST="$ROOT/src-tauri/Info.plist"

[[ -f "$COUNTER" ]] || echo 0 > "$COUNTER"
current="$(tr -d '[:space:]' < "$COUNTER")"
[[ "$current" =~ ^[0-9]+$ ]] || current=0

if [[ "${1:-}" == "--show" ]]; then
  echo "$current"
  exit 0
fi

next=$(( current + 1 ))
echo "$next" > "$COUNTER"

# CFBundleVersion を書き込む(無ければ足す)。Info.plist は cargo tauri build 時に
# 自動生成の plist へマージされるので、ここに入れれば .app に載る。
if /usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $next" "$PLIST"
else
  /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $next" "$PLIST"
fi

version="$(python3 -c "import json,sys; print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['version'])")"
echo "build number: $current -> $next  (version $version)"

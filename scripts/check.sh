#!/usr/bin/env bash
# 「人に聞かなくても正解が一意に決まる」検査をまとめて回す。
#
# ここに入れてよいのは、機械が黙って判定できるものだけ。判断が要るもの(設計の是非・
# 何を公開するか・ライセンスの選択)は入れない——警告が出るたびに人を止めることになり、
# 結局その警告が読まれなくなる。
#
#   ./scripts/check.sh
#
# CI(.github/workflows/ci.yml)からも同じものを回す。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

fail=0
run() {
  printf '\n\033[1m==> %s\033[0m\n' "$1"; shift
  if "$@"; then :; else fail=1; fi
}

run "ロジックのユニットテスト"           node tests/logic.test.mjs
run "メニューの配線(無反応な項目)"       node scripts/check-menu-wiring.mjs
run "画面に出る文字列の直書き(i18n)"     node scripts/check-ui-strings.mjs
run "設定・版番号・秘匿パス"             node scripts/check-config.mjs
run "機能の記録(文書に書く対象の洗い出し)" node scripts/feature-inventory.mjs
run "記号の突き合わせ(実装と文書の食い違い)" node scripts/check-symbols.mjs
run "文書に書いた画面の文字が実物と合うか" node scripts/check-manual-labels.mjs

printf '\n'
if [ "$fail" -ne 0 ]; then
  printf '\033[31m検査に失敗があります\033[0m\n'
  exit 1
fi
printf '\033[32mすべて通過\033[0m\n'

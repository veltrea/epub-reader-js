// 文書に書いてある「画面の文字」が、実際に画面へ出るものと合っているかを見る。
//
//   node scripts/check-manual-labels.mjs
//
// **なぜ要るか。** マニュアルは Swift 版の試作品を叩き台にして書いた。そのため
// 試作品のころの名前が残る。2026-08-30 に 9 か所見つかった——アプリ名が
// 「EpubReaderSpike」、設定が「環境設定…」（実際は「設定…」）、書き出しが
// 「オーディオを書き出し…」（実際は「この章を音声ファイルに保存…」）など。
// 人が読み比べても気づけない。機械で突き合わせる。
//
// **何と比べるか。** 画面に出る文字は全部 src/locales/ja.json にある
// （直書きは check-ui-strings.mjs が禁じている）。だからそこを正とする。
//
// **何を見るか。** 誤検出が多いと警告が読まれなくなるので、**確実に画面の文字だと
// 分かる形だけ**を見る。
//   1. 「…」で終わる語  … メニュー項目はこの形で終わる
//   2. 「A > B」の形     … メニューの経路
// 説明の言い回し（「自動／縦書き／横書き」など）は見ない。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => join(ROOT, p);

// 画面に出る文字（言語ファイルが正）
const ja = JSON.parse(readFileSync(R('src/locales/ja.json'), 'utf8'));
const labels = new Set(Object.values(ja).filter((v) => typeof v === 'string').map((v) => v.trim()));

// メニューバーの見出し。経路の左側はこれのどれかになる。
const MENU_TOPS = new Set(['ファイル', '編集', '表示', '移動', '読み上げ', 'ウインドウ', 'epub-reader']);

// 見なくてよいもの。理由を必ず書くこと。
const SKIP = new Set([
  '本文へ移動',            // ページの中の飛び先。画面の部品ではない
  'この場所だけの読み',    // 章の見出し。項目名は「この場所だけの読みを登録」
]);

// 日本語の文書だけを見る。英語は「…」を文の省略に使うので、この見分け方が働かない
// （"Open the engine…" の "engine…" を項目名と取り違える）。
const TARGETS = ['docs/manual/manual.html', 'docs/manual/index.html', 'MANUAL.ja.md']
  .filter((p) => existsSync(R(p)));

const unescape = (s) => s
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

let bad = 0, checked = 0;
for (const rel of TARGETS) {
  const raw = unescape(readFileSync(R(rel), 'utf8'));
  const text = raw.replace(/<[^>]+>/g, ' ');       // 印を外して本文だけにする
  const lines = raw.split('\n');
  const found = new Map();                          // 語 → 最初に出てきた行

  const remember = (word) => {
    if (!word || found.has(word)) return;
    const i = lines.findIndex((l) => unescape(l).includes(word));
    found.set(word, i >= 0 ? i + 1 : 0);
  };

  // 1. 「…」で終わる語。区切り（／・）と飾り（* _ `）は語の一部ではないので外す。
  for (const m of text.matchAll(/[^\s「」『』（）(),、。>＞/|・／*_`]{2,24}…/g)) remember(m[0]);
  // 2. 「A > B」「A > B > C」の形。右端だけを見る（左は見出しなので別に確かめる）
  // 右端に文末の句点や飾りが付くので、そこで切る。
  for (const m of text.matchAll(/([^\s「」（）]{2,12})\s*>\s*([^\s「」（）。、）*_`]{2,24})/g)) {
    if (MENU_TOPS.has(m[1])) remember(m[2]);
  }

  for (const [word, line] of found) {
    if (SKIP.has(word)) continue;
    checked++;
    // そのままある / 「…」を外せばある / 前後に飾りが付いているだけ、を通す
    const plain = word.replace(/…$/, '');
    const ok = labels.has(word) || labels.has(plain)
      || [...labels].some((l) => l === word || l.startsWith(word) || l.startsWith(plain + '（') || l.startsWith(plain + '('));
    if (!ok) {
      console.log(`\x1b[31m  NG\x1b[0m ${rel}:${line}  「${word}」は画面に出る文字にない`);
      bad++;
    }
  }
}

if (TARGETS.length === 0) {
  console.log('ok — 突き合わせる文書がない（公開ツリーには docs/manual を写していない）');
} else if (bad) {
  console.log(`\n\x1b[31m画面の文字と食い違う書き方が ${bad} 件あります\x1b[0m`);
  console.log('  src/locales/ja.json にある文字へ直すこと。');
  console.log('  画面の側が正しくないなら、そちらを直してから文書を直すこと。');
  process.exit(1);
} else {
  console.log(`ok — 文書 ${TARGETS.length} 件の中の ${checked} 個の語が、画面の文字と一致`);
}

// 画面に出る文字列の直書き(i18n 漏れ)を機械で見つける。
//
// **リテラルの有無ではなく「出口」で見る。** かな処理や文分割には日本語のリテラルが正当に
// 出てくる(`kana.js` の五十音表、句読点など)ので、「日本語の文字列があるか」で探すと
// 誤検出だらけになって誰も見なくなる。代わりに **画面へ流し込む代入・呼び出し**だけを見る。
//
// 過去に漏れた 2 件は、どちらもこの検査で捕まる:
//   ui-modals.js  alert('再生に失敗しました: ' + e)
//   dnd.js        el.textContent = '本をここにドロップ'
//
// 実行: node scripts/check-ui-strings.mjs

import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'src/app';
// 画面に出る出口。ここへ日本語のリテラルが直接入っていたら漏れ。
const SINKS = [
  /\.(?:textContent|innerHTML|innerText|title|placeholder|ariaLabel)\s*=\s*(?!.*\bt\()/,
  /\b(?:alert|confirm|prompt|toast|notice)\(\s*(?!.*\bt\()/,
  /\blabel\s*:\s*(?!.*\bt\()/,
];
const JA = /[぀-ゟ゠-ヿ一-鿿]/;

/** 行コメント・ブロックコメントを落とす(文字列の中の // は消さない)。 */
function stripComments(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n && !(src[i] === q && src[i - 1] !== '\\')) { out += src[i]; i++; }
      out += src[i] ?? ''; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const hits = [];
for (const name of readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
  const path = `${DIR}/${name}`;
  const lines = stripComments(readFileSync(path, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (!JA.test(line)) return;
    // 日本語を含む文字列リテラルがあるか
    if (!/(['"`])[^'"`]*[぀-ゟ゠-ヿ一-鿿][^'"`]*\1/.test(line)) return;
    if (SINKS.some((re) => re.test(line))) {
      hits.push(`${path}:${i + 1}  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (hits.length) {
  console.error(`画面に出る文字列が直書きされています (${hits.length} 件):`);
  for (const h of hits) console.error(`  ${h}`);
  console.error('\nsrc/locales/{ja,en}.json にキーを足して t(...) 経由にしてください。');
  process.exit(1);
}
console.log('ok — 画面に出る文字列の直書きなし');

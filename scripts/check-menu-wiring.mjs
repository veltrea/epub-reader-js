// ネイティブメニューの「項目はあるのに押しても何も起きない」を機械で見つける。
//
// この穴は目視では見つからない——メニューは組み上がるし、押してもエラーも出ず、ただ黙って
// いるだけだから。公開版で最も目立つ種類の不具合なので、検査で落とす。
//
// 判定: menu.rs が出す id のうち、その画面で **enabled** になるものが、その画面のハンドラ表に
// 無ければ穴。
//   enabled が `true`   → reader / shelf の両方に要る
//   enabled が `reader` → reader.js に要る
//   enabled が `shelf`  → shelf.js に要る
//   それ以外の式(can_export / pager_running 等) → 文脈依存。どちらにも無ければ警告
//
// 実行: node scripts/check-menu-wiring.mjs

import { readFileSync } from 'node:fs';

const menuRs = readFileSync('src-tauri/src/menu.rs', 'utf8');
const readerJs = readFileSync('src/app/reader.js', 'utf8');
const shelfJs = readFileSync('src/app/shelf.js', 'utf8');

// ---- menu.rs が出す id と、その enabled 条件 ----------------------------------

/** @type {Map<string, string>} id(または接頭辞) -> enabled の式 */
const ids = new Map();

for (const call of calls(menuRs, ['item', 'check', 'raw_check'])) {
  const args = splitTopLevel(call);
  const first = (args[0] || '').trim();
  const enabled = (args[args.length - 1] || '').trim();

  // "file.import" のような直書き
  let m = first.match(/^"([a-z][\w.]*)"$/);
  if (m) { ids.set(m[1], enabled); continue; }

  // &format!("go.autoPager.{n}") のような動的 id は接頭辞として持つ
  // (ハンドラ側も接頭辞キーで受けるため)。
  m = first.match(/^&?format!\(\s*"([a-z][\w.]*)\.\{/);
  if (m) { ids.set(m[1] + '.', enabled); continue; }

  // &format!("{id_base}.{v}") は接頭辞が変数。呼び出し側(triple)から拾う。
}

// triple("menu.view.writing", "view.writing", [...], cur) の第2引数が id_base。
// 中の check(...) は enabled = true で作られる。
for (const call of calls(menuRs, ['triple'])) {
  const args = splitTopLevel(call);
  const m = (args[1] || '').trim().match(/^"([a-z][\w.]*)"$/);
  if (m) ids.set(m[1] + '.', 'true');
}

/** `name(...)` の呼び出しを見つけ、括弧の中身をそのまま返す(ネスト・文字列に耐える)。 */
function calls(src, names) {
  const out = [];
  const re = new RegExp(`\\b(?:${names.join('|')})\\(`, 'g');
  for (const m of src.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    let depth = 0, inStr = false;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (inStr) { if (c === '"' && src[i - 1] !== '\\') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { out.push(src.slice(open + 1, i)); break; } }
    }
  }
  return out;
}

/** 括弧の深さを見ながらカンマで割る。 */
function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '"' && s[i - 1] !== '\\') inStr = false; cur += c; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---- 各画面のハンドラ表 ------------------------------------------------------

/** setupMenu('<screen>', { ... }) の中のキーを集める。 */
function handlers(src, screen) {
  const start = src.indexOf(`setupMenu('${screen}'`);
  if (start < 0) throw new Error(`setupMenu('${screen}') が見つかりません`);
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return new Set([...src.slice(open, end).matchAll(/'([a-z][\w.]*)'\s*:/g)].map((m) => m[1]));
}

const table = { reader: handlers(readerJs, 'reader'), shelf: handlers(shelfJs, 'shelf') };

/** 完全一致か、接頭辞キー('go.autoPager.' 等)で受けられるか。 */
function handled(set, id) {
  if (set.has(id)) return true;
  for (const k of set) if (k.endsWith('.') && id.startsWith(k)) return true;
  return false;
}

// ---- 突き合わせ --------------------------------------------------------------

const errors = [];
const warnings = [];

for (const [id, enabled] of [...ids].sort()) {
  const need =
    enabled === 'true' ? ['reader', 'shelf']
    : enabled === 'reader' ? ['reader']
    : enabled === 'shelf' ? ['shelf']
    : null;

  if (need) {
    for (const screen of need) {
      if (!handled(table[screen], id)) {
        errors.push(`${id}  —  ${screen} で有効なのに ${screen}.js にハンドラが無い (enabled: ${enabled})`);
      }
    }
  } else if (!handled(table.reader, id) && !handled(table.shelf, id)) {
    warnings.push(`${id}  —  どちらの画面にもハンドラが無い (enabled: ${enabled})`);
  }
}

// 逆向き: ハンドラだけ残って menu.rs から項目が消えたもの(押される経路が無い)。
for (const screen of ['reader', 'shelf']) {
  for (const key of table[screen]) {
    const live = [...ids.keys()].some((id) =>
      id === key || (key.endsWith('.') && id.startsWith(key)) || (id.endsWith('.') && key.startsWith(id)));
    if (!live) warnings.push(`${key}  —  ${screen}.js に残っているが menu.rs に項目が無い(死んだハンドラ)`);
  }
}

for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
  console.error(`\nメニューの配線に穴があります (${errors.length} 件):`);
  for (const e of errors) console.error(`  ${e}`);
  console.error('\nmenu.rs に項目を足したら、reader.js と shelf.js の**両方**のハンドラ表を見ること。');
  process.exit(1);
}
console.log(`ok — ${ids.size} 個のメニュー id を検査 (warn ${warnings.length})`);

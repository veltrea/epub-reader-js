// 実装と文書を、それぞれ「1 行 = 1 機能」の小さな表に直す。
//
// **なぜ小さくするか**: 突き合わせを速くするためではなく、**食い違いに早く気付くため**。
// 33 万バイトのコードを読んで判断する代わりに、数キロバイトの表を引き算する。
// 引き算に AI は要らない。AI が要るのは「表を作るとき」と「差を文章にするとき」だけ。
//
// 1 行の形（空白区切り・4 列）:
//
//     <グループ>  <表題 id>  <文書>  <表示名>
//     reader      menu:edit.find      JM   本文を検索…
//     reader,tts  cmd:ttsFromHere     -    （表示名なし）
//
// - **グループ**は一意でない。1 つの機能が複数のグループに属してよい（カンマで並べる）。
//   グループの軸は**マニュアルの節に合わせる**。コードのメニュー構成には合わせない。
//   読む人の見方で切らないと、「節ごと説明が抜けている」を見つけられないため。
// - **表題 id** は既にある一意な名前をそのまま使う（`menu:` `set:` `cmd:` `fmt:`）。
//   名前を持たない機能だけ `feat:` で新しく振る。**連番は使わない**——項目が増えると
//   ずれて、前回との差が取れなくなる。
// - **文書**は説明が見つかった場所。J=MANUAL.ja.md M=MANUAL.md R=README(英日どちらか) -=どこにも無い
//
//   node scripts/symbols.mjs            # 表を出す
//   node scripts/symbols.mjs --json     # 機械で読む形で出す
//
// 突き合わせは scripts/check-symbols.mjs が行う。

import { readFileSync, readdirSync } from 'node:fs';

// ---- グループ（マニュアルの節に合わせた軸） ----------------------------------
export const GROUPS = {
  setup: 'セットアップ',
  shelf: '書棚',
  reader: 'リーダー',
  tts: '読み上げ',
  trans: '対訳',
  export: '書き出し',
  data: 'データの保存場所',
};

// メニュー id の頭から、どのグループに属するかを決める。
// 1 つの id が複数のグループに属してよい。
const MENU_GROUP = [
  [/^file\.(import|importFolder|newProfile|profiles)/, ['shelf']],
  [/^file\.save(Audio|Video)/, ['export', 'tts']],
  [/^go\.shelf/, ['shelf', 'reader']],
  [/^go\./, ['reader']],
  [/^tts\.sleep/, ['tts', 'reader']],
  [/^tts\./, ['tts']],
  [/^view\.(render|binding|aspect|spread|imageSpread|textSpread)/, ['reader']],
  [/^view\.translate/, ['trans']],
  [/^view\./, ['reader']],
  [/^edit\./, ['reader']],
  [/^app\.settings/, ['setup', 'reader', 'tts', 'trans']],
];

// 設定の鍵から、どのグループに属するかを決める。
const SET_GROUP = [
  [/^(engine|customBaseUrl|speaker|speedScale|pauseLengthScale|sleepTimer)/, ['tts']],
  [/^ttsSaveDir/, ['export', 'tts']],
  [/^translation/, ['trans']],
  [/^(shelfView|sortKey)/, ['shelf']],
  [/^(theme|lang)/, ['setup']],
  [/./, ['reader']],
];

function groupsFor(name, table) {
  for (const [re, gs] of table) if (re.test(name)) return gs;
  return ['reader'];
}

// ---- 実装から抜き出す --------------------------------------------------------
export function fromCode() {
  const ja = JSON.parse(readFileSync('src/locales/ja.json', 'utf8'));
  const menuRs = readFileSync('src-tauri/src/menu.rs', 'utf8');
  const storeJs = readFileSync('src/app/store.js', 'utf8');
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const rows = [];

  for (const m of menuRs.matchAll(/(?:item|check)\(\s*"([a-z][\w.]*)"\s*,\s*"([\w.]+)"/g)) {
    const [, id, key] = m;
    if (!ja[key]) continue;
    rows.push({ id: `menu:${id}`, groups: groupsFor(id, MENU_GROUP), label: ja[key] });
  }

  const defaults = storeJs.match(/export const DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  for (const m of defaults.matchAll(/^\s{2}(\w+):/gm)) {
    rows.push({ id: `set:${m[1]}`, groups: groupsFor(m[1], SET_GROUP), label: '' });
  }

  const exts = conf.bundle?.fileAssociations?.flatMap((a) => a.ext) ?? [];
  for (const e of [...new Set(exts)].sort()) {
    rows.push({ id: `fmt:${e}`, groups: ['shelf'], label: '' });
  }

  // 名前を持たない機能。ソースのコメントに書いた印から拾う。
  //   // [feat:vertical-auto][reader] 縦書き宣言だけ残った本を自動で縦書きにする
  for (const path of sourceFiles()) {
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/\[(feat:[a-z0-9-]+)\]\[([a-z,]+)\]\s*(.*)/g)) {
      rows.push({ id: m[1], groups: m[2].split(','), label: m[3].trim() });
    }
  }

  // 同じ id が複数回出てもよい（複数のファイルにまたがる機能）。グループは束ねる。
  const byId = new Map();
  for (const r of rows) {
    const cur = byId.get(r.id);
    if (cur) { cur.groups = [...new Set([...cur.groups, ...r.groups])]; cur.label ||= r.label; }
    else byId.set(r.id, { ...r, groups: [...new Set(r.groups)] });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function sourceFiles() {
  const out = [];
  for (const d of ['src/app', 'src-tauri/src']) {
    for (const f of readdirSync(d)) if (/\.(js|rs)$/.test(f)) out.push(`${d}/${f}`);
  }
  return out;
}

// ---- 文書から抜き出す --------------------------------------------------------
const DOC_FILES = [
  ['J', 'MANUAL.ja.md'],
  ['M', 'MANUAL.md'],
  ['R', 'README.ja.md'],
  ['R', 'README.md'],
];

/** 文書に出てくる id と、節に書いたグループの印を拾う。 */
export function fromDocs() {
  const idsIn = new Map();     // id -> 見つかった文書の記号
  const groupsIn = new Map();  // 文書の記号 -> グループの集合
  for (const [mark, path] of DOC_FILES) {
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    if (!groupsIn.has(mark)) groupsIn.set(mark, new Set());
    for (const m of text.matchAll(/<!--\s*group:([a-z]+)\s*-->/g)) groupsIn.get(mark).add(m[1]);
    // 1 つの印に id を何個並べてもよい。マニュアルの 1 行が複数の機能を説明することは
    // 普通にあるので（「書棚を切り替える / 書棚を管理… / 新規書棚…」など）、
    // 機能ごとに印を分けさせると文書が印だらけになる。
    for (const c of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      for (const m of c[1].matchAll(/(?:menu|set|cmd|fmt|feat):[\w.-]+/g)) {
        if (!idsIn.has(m[0])) idsIn.set(m[0], new Set());
        idsIn.get(m[0]).add(mark);
      }
    }
  }
  return { idsIn, groupsIn };
}

/** 表示名が文書の本文に出てくるか（印がまだ無い機能のための、弱い手掛かり）。 */
export function labelHits(label) {
  if (!label) return new Set();
  const hit = new Set();
  for (const [mark, path] of DOC_FILES) {
    try { if (readFileSync(path, 'utf8').includes(label)) hit.add(mark); } catch { /* 無ければ飛ばす */ }
  }
  return hit;
}

// ---- 出力 --------------------------------------------------------------------
export function build() {
  const code = fromCode();
  const { idsIn, groupsIn } = fromDocs();
  return code.map((r) => {
    const byId = idsIn.get(r.id) ?? new Set();
    const marks = byId.size ? byId : labelHits(r.label);
    return { ...r, docs: [...marks].sort().join('') || '-', byId: byId.size > 0 };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = build();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ groups: GROUPS, rows }, null, 2));
  } else {
    const w = Math.max(...rows.map((r) => r.id.length));
    for (const r of rows) {
      console.log(`${r.groups.join(',').padEnd(18)} ${r.id.padEnd(w)} ${r.docs.padEnd(4)} ${r.label}`);
    }
    const bytes = rows.reduce((n, r) => n + r.id.length + r.groups.join(',').length + 8, 0);
    console.error(`\n${rows.length} 行 / およそ ${bytes.toLocaleString()} バイト`);
  }
}

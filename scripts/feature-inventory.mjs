// 機能の一覧をコードから機械的に取り出して、記録と突き合わせる。
//
// **なぜ AI に解析させないか**: 機能の一覧は推測して作るものではなく、コードに既に
// 宣言されている——メニューの id、設定のキー、テストバスのコマンド、対応拡張子、
// バックエンドのコマンド。抜き出すのは grep と同じで、差分は git が取る。
// 文章を書くところだけ人(または AI)がやればよく、毎回全部を読ませる必要はない。
//
// 使い方:
//   node scripts/feature-inventory.mjs           # 記録と食い違っていないか検査
//   node scripts/feature-inventory.mjs --write    # 記録を更新する
//
// 検査が落ちたときは、出力された差分が**そのまま「書く対象」**になる。
// 記録を更新して、増えた項目を MANUAL / README に書く。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OUT = 'docs/feature-inventory.json';
const write = process.argv.includes('--write');

const ja = JSON.parse(readFileSync('src/locales/ja.json', 'utf8'));
const menuRs = readFileSync('src-tauri/src/menu.rs', 'utf8');
const libRs = readFileSync('src-tauri/src/lib.rs', 'utf8');
const storeJs = readFileSync('src/app/store.js', 'utf8');
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));

// ---- メニュー項目(id と、画面に出る日本語のラベル) ---------------------------
const menu = {};
for (const m of menuRs.matchAll(/(?:item|check)\(\s*"([a-z][\w.]*)"\s*,\s*"([\w.]+)"/g)) {
  const [, id, key] = m;
  if (ja[key]) menu[id] = ja[key];
}

// ---- 設定のキー --------------------------------------------------------------
const defaults = storeJs.match(/export const DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
const settings = [...defaults.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();

// ---- テストバスのコマンド ----------------------------------------------------
function testbusCommands(path) {
  const src = readFileSync(path, 'utf8');
  const start = src.indexOf('registerTestbus({');
  if (start < 0) return [];
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end);
  // 直下のプロパティだけを拾う(ネストしたオブジェクトの中は見ない)
  let d = 0;
  const names = [];
  for (const line of body.split('\n')) {
    if (d === 0) {
      const m = line.match(/^\s{4}(\w+)\s*:/);
      if (m) names.push(m[1]);
    }
    d += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length;
  }
  return names.sort();
}

// ---- バックエンドのコマンド --------------------------------------------------
const handler = libRs.match(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1] ?? '';
const commands = [...handler.matchAll(/^\s*(\w+),?\s*$/gm)].map((m) => m[1]).sort();

// ---- 対応形式 ----------------------------------------------------------------
const formats = (conf.bundle?.fileAssociations ?? []).flatMap((a) => a.ext ?? []).sort();

// ---- 星取り図(記号 × 文書) ---------------------------------------------------
// 機能は記号で、文書はその記号を覆っているかどうか。**両方向**に効く:
//   本体にある × 文書に無い  → 書き漏らし
//   本体に無い × 文書にある  → 残骸(消した機能の説明が残っている)
// 記号→本文の対応づけは、画面に出るラベル(ja / en)の文字列一致で取る。ラベルは
// locales が唯一の出所なので、文書の側に印を打たなくても突き合わせられる。
const en = JSON.parse(readFileSync('src/locales/en.json', 'utf8'));
const DOCS = ['MANUAL.ja.md', 'MANUAL.md', 'README.ja.md', 'README.md'];
const docText = Object.fromEntries(DOCS.map((f) => [f, norm(existsSync(f) ? readFileSync(f, 'utf8') : '')]));

/** 表記ゆれ(全角の三点リーダ・空白・スラッシュ回り)を吸収する。 */
function norm(s) { return s.replace(/[…\s／]/g, '').toLowerCase(); }

/** その記号が、どの文書に出ているか。 */
function coverOf(labels) {
  const keys = labels.filter(Boolean).map(norm).filter((s) => s.length >= 3);
  if (!keys.length) return [];
  return DOCS.filter((f) => keys.some((k) => docText[f].includes(k)));
}

const coverage = {};
for (const m of menuRs.matchAll(/(?:item|check)\(\s*"([a-z][\w.]*)"\s*,\s*"([\w.]+)"/g)) {
  const [, id, key] = m;
  if (!ja[key]) continue;
  coverage[id] = coverOf([ja[key], en[key]]);
}
for (const ext of formats) coverage[`format.${ext}`] = coverOf([ext]);

const inventory = {
  note: 'scripts/feature-inventory.mjs が生成する。手で編集しない。'
    + ' 差分が出たら、増えた項目を MANUAL / README に書いてから --write で更新する。'
    + ' coverage は「記号 × 文書」の星取り図で、本体から機能を消したときに'
    + ' 文書へ説明が残っていないかを逆向きに調べるために使う。',
  version: conf.version,
  menu: Object.fromEntries(Object.entries(menu).sort(([a], [b]) => a.localeCompare(b))),
  settings,
  formats,
  backendCommands: commands,
  testbus: {
    reader: testbusCommands('src/app/reader.js'),
    shelf: testbusCommands('src/app/shelf.js'),
  },
  coverage: Object.fromEntries(Object.entries(coverage).sort(([a], [b]) => a.localeCompare(b))),
};

const json = JSON.stringify(inventory, null, 2) + '\n';

// ---- 星取り図を表示する ------------------------------------------------------
if (process.argv.includes('--chart')) {
  const head = ['記号', ...DOCS.map((f) => f.replace(/\.md$/, ''))];
  const rows = Object.entries(coverage).map(([sym, on]) =>
    [sym, ...DOCS.map((f) => (on.includes(f) ? '✓' : '—'))]);
  const w = head.map((_, i) => Math.max(...[head, ...rows].map((r) => [...r[i]].length)));
  const line = (r) => '| ' + r.map((c, i) => c + ' '.repeat(w[i] - [...c].length)).join(' | ') + ' |';
  console.log(line(head));
  console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|');
  for (const r of rows) console.log(line(r));
  const holes = rows.filter((r) => r.slice(1).every((c) => c === '—'));
  console.log(`\n${rows.length} 個の記号 / どの文書にも出ていない: ${holes.length}`);
  process.exit(0);
}

if (write) {
  writeFileSync(OUT, json);
  console.log(`書き出しました: ${OUT}`);
  process.exit(0);
}

if (!existsSync(OUT)) {
  console.error(`${OUT} がありません。node scripts/feature-inventory.mjs --write で作ってください。`);
  process.exit(1);
}

const prev = JSON.parse(readFileSync(OUT, 'utf8'));
const diffs = [];

const cmp = (label, before, after) => {
  const a = new Set(before), b = new Set(after);
  for (const x of b) if (!a.has(x)) diffs.push(`+ ${label}: ${x}`);
  for (const x of a) if (!b.has(x)) diffs.push(`- ${label}: ${x}`);
};

cmp('設定', prev.settings ?? [], settings);
cmp('対応形式', prev.formats ?? [], formats);
cmp('バックエンドのコマンド', prev.backendCommands ?? [], commands);
cmp('テストバス(リーダー)', prev.testbus?.reader ?? [], inventory.testbus.reader);
cmp('テストバス(書棚)', prev.testbus?.shelf ?? [], inventory.testbus.shelf);

const prevMenu = prev.menu ?? {};
for (const [id, label] of Object.entries(inventory.menu)) {
  if (!(id in prevMenu)) diffs.push(`+ メニュー: ${id} 「${label}」`);
  else if (prevMenu[id] !== label) diffs.push(`~ メニュー: ${id} 「${prevMenu[id]}」→「${label}」`);
}
for (const id of Object.keys(prevMenu)) {
  if (!(id in inventory.menu)) diffs.push(`- メニュー: ${id} 「${prevMenu[id]}」`);
}

if (prev.version !== conf.version) diffs.push(`~ 版番号: ${prev.version} → ${conf.version}`);

// ---- 逆向き: 本体から消えたのに文書に残っているもの ---------------------------
// 記録していた記号が実装から消えたとき、その記号のラベルがまだ文書に出ているなら、
// 説明だけが残骸として残っている。これは「増えたものを書く」検査では絶対に見つからない。
const stale = [];
for (const [sym, docs] of Object.entries(prev.coverage ?? {})) {
  if (sym in coverage) continue;              // まだ実装にある
  const still = docs.filter((f) => (coverage[sym] ?? []).length === 0 && docText[f]);
  if (!still.length) continue;
  // 記録時のラベルで、いまも文書に出ているかを確かめる
  const id = sym.replace(/^format\./, '');
  const label = prev.menu?.[sym] ?? id;
  const hit = DOCS.filter((f) => norm(label).length >= 3 && docText[f].includes(norm(label)));
  if (hit.length) stale.push(`! 残骸: ${sym} 「${label}」は実装から消えているが ${hit.join(' / ')} に説明が残っています`);
}
diffs.push(...stale);

// どの文書にも出ていない記号(書き漏らし)。警告どまり——文章は人が書くため。
const uncovered = Object.entries(coverage).filter(([, on]) => on.length === 0).map(([s]) => s);
if (uncovered.length) {
  console.warn(`warn: どの文書にも出ていない機能が ${uncovered.length} 件: ${uncovered.join(' / ')}`);
}

if (diffs.length) {
  console.error(`機能の記録が実装とずれています (${diffs.length} 件):\n`);
  for (const d of diffs) console.error(`  ${d}`);
  console.error(`
この差分が、そのまま「文書に書く対象」です。
  1. 増えた項目を MANUAL.ja.md / MANUAL.md（大きい機能なら README も）に書く
  2. node scripts/feature-inventory.mjs --write で記録を更新する`);
  process.exit(1);
}
console.log(`ok — 機能の記録は実装と一致 (メニュー ${Object.keys(menu).length} / 設定 ${settings.length} / コマンド ${commands.length})`);

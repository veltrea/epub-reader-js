// 実装と文書の食い違いを、集合の引き算だけで見つける。
//
// 比べ方は 4 種類しかない（.claude/skills/symbol-matching/SKILL.md）。
// ここで使うのは **包含** と **相等** の 2 つ。
//
//   包含  A ⊆ B  が破れる → 宣言だけあって実体が無い
//   相等  A = B  が破れる → 片方だけ直した
//
// 見つけるのは 4 本:
//   1. グループ  コードのグループ ⊆ 文書のグループ   … 節ごと説明が無い
//   2. 機能      コードの表題 id ⊆ 文書の id         … その機能の説明が無い
//   3. 逆向き    文書の id ⊆ コードの表題 id         … 実装が無い説明が残っている
//   4. 二か国語  日本語版の id = 英語版の id          … 片方の言語だけ書いた
//
//   node scripts/check-symbols.mjs          # 検査（食い違いがあれば 1 で終わる）
//   node scripts/check-symbols.mjs --soft   # 数だけ出して、失敗にしない（移行中に使う）
//
// **緑になっても「できている」ではない。** 分かるのは「同じ名前がどこかに 1 回は出てくる」
// だけで、説明の量・正しさ・画面の見た目は範囲外。最後は自分の目で見る。

import { build, fromCode, fromDocs, GROUPS } from './symbols.mjs';

const soft = process.argv.includes('--soft');
let bad = 0;

const sub = (a, b) => [...a].filter((x) => !b.has(x));
function report(title, missing, hint) {
  if (!missing.length) { console.log(`  ok   ${title}`); return; }
  bad += soft ? 0 : 1;
  console.log(`\x1b[31m  NG   ${title} — ${missing.length} 件\x1b[0m`);
  console.log(`       ${hint}`);
  for (const x of missing.slice(0, 12)) console.log(`       - ${x}`);
  if (missing.length > 12) console.log(`       …ほか ${missing.length - 12} 件`);
}

const rows = build();
const { idsIn, groupsIn } = fromDocs();

// ---- 1. グループ（節ごと抜けていないか） -------------------------------------
const codeGroups = new Set(rows.flatMap((r) => r.groups));
const jaGroups = groupsIn.get('J') ?? new Set();
report(
  'マニュアル(日本語)に、コード側の全グループの節がある',
  sub(codeGroups, jaGroups).map((g) => `${g}（${GROUPS[g] ?? g}）の節が無い`),
  'その分野の説明が丸ごと無い。1 件だけの書き忘れとは意味が違う。',
);

// ---- 2. 機能（説明が無い） ---------------------------------------------------
const codeIds = new Set(rows.map((r) => r.id));
const docIds = new Set(idsIn.keys());
report(
  'コードの表題 id が、どれか 1 つの文書に印付きで出てくる',
  sub(codeIds, docIds),
  '印（<!-- menu:xxx --> の形）を付けた説明が文書に無い。',
);

// ---- 3. 逆向き（実装が無い説明） ---------------------------------------------
report(
  '文書の id が、すべてコードに実在する',
  sub(docIds, codeIds),
  '消した機能の説明が文書に残っている。',
);

// ---- 4. 二か国語（片方だけ書いた） -------------------------------------------
const inJa = new Set([...idsIn].filter(([, m]) => m.has('J')).map(([id]) => id));
const inEn = new Set([...idsIn].filter(([, m]) => m.has('M')).map(([id]) => id));
report(
  'マニュアルの日本語版と英語版に、同じ id がある',
  [...sub(inJa, inEn).map((x) => `${x} … 英語版に無い`), ...sub(inEn, inJa).map((x) => `${x} … 日本語版に無い`)],
  '手書きの二か国語なので、片方だけ書き足した状態になりやすい。',
);

// ---- まとめ ------------------------------------------------------------------
const marked = rows.filter((r) => r.byId).length;
console.log(`\n  表題 id ${rows.length} 個 / 印を付けた説明 ${marked} 個 / グループ ${codeGroups.size} 種類`);
if (marked < rows.length) {
  console.log(`  \x1b[33m印がまだ ${rows.length - marked} 個ぶん付いていない。` +
    `表示名の一致で代用しているので、名前を変えると外れる。\x1b[0m`);
}
if (bad) { console.log('\n\x1b[31m食い違いがあります\x1b[0m'); process.exit(1); }
console.log('\n\x1b[32m通過\x1b[0m');

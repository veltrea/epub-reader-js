// 純粋ロジックのテスト(DOM不要)。実行: node tests/logic.test.mjs
import assert from 'node:assert';
import { hiraganaToKatakana, katakanaToHiragana, gojuonSection } from '../src/app/kana.js';
import { normalizeEntry, normalizeList, prepare, gapRuns, BOUNDARY } from '../src/app/dictionary.js';
import {
  declaresVertical, shouldAutoVertical, resolveWritingMode, resolveDir,
  nextBinding, initialBookDir, noteSectionDirection,
} from '../src/app/writing-mode.js';
import { hangingFix, guessSectionFor, hrefFileName, normalizeWritingHint, opfHintCSS } from '../src/app/typeset.js';
import { parseAspect, aspectToString, setPref, resolvePref, nextSpread, BOOK_ONLY_KEYS } from '../src/app/prefs.js';
import { cleanCompletion, cacheKey, userPrompt } from '../src/app/translate.js';
import * as col from '../src/app/collections.js';
import {
  PRIMARY_ID, normalizeIndex, initialIndex, addProfile, renameProfile,
  canRemoveProfile, removeProfile, scopedKey, SCOPED_KEYS,
} from '../src/app/profiles.js';
import { AutoPager, END_THRESHOLD } from '../src/app/autopager.js';
import { SleepTimer, formatRemaining, normalizeAction, recordingPower, SHUTDOWN_GRACE } from '../src/app/sleeptimer.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  -', name); }
  catch (e) { fail++; console.error('  FAIL-', name, '\n   ', e.message); }
}

// --- kana ---
test('ひら→カタ', () => assert.equal(hiraganaToKatakana('ひとし'), 'ヒトシ'));
test('カタ→ひら', () => assert.equal(katakanaToHiragana('ヒトシ'), 'ひとし'));
test('長音・記号は保持', () => assert.equal(hiraganaToKatakana('あー、ん'), 'アー、ン'));

// --- 五十音分類 ---
test('yomi優先で分類', () => assert.equal(gojuonSection('なつめ', '夏目漱石'), 'な'));
test('濁点は清音の行へ', () => assert.equal(gojuonSection('ぐんじょう', ''), 'か'));
test('カタカナyomiも可', () => assert.equal(gojuonSection('メタン', ''), 'ま'));
test('小書き先頭', () => assert.equal(gojuonSection('ゃがいも', ''), 'や'));
test('漢字のみ→他', () => assert.equal(gojuonSection('', '魔王'), '他'));
test('英字→大文字セクション(Swift準拠)', () => assert.equal(gojuonSection('', 'ABC'), 'A'));
test('数字→#', () => assert.equal(gojuonSection('', '007'), '#'));
test('作者なし→—', () => assert.equal(gojuonSection('', ''), '—'));

// --- 読み辞書(レイヤー付き前処理。SPECIFICATION.ja.md §10.2) ---
test('欠損は既定値(レイヤー5・語・境界なし・有効)', () => {
  const e = normalizeEntry({ surface: '斎', reading: 'いつき' });
  assert.deepEqual(e, { surface: '斎', reading: 'いつき', layer: 5, kind: 'word', padsBoundary: false, enabled: true });
});
test('旧形式(yomi/priority)は読み替えて移行できる', () => {
  const e = normalizeEntry({ surface: '斎', yomi: 'いつき', priority: 8 });
  assert.equal(e.reading, 'いつき');
  assert.equal(e.layer, 8);
});
test('surface/reading空はnull', () => {
  assert.equal(normalizeEntry({ surface: '', reading: 'x' }), null);
  assert.equal(normalizeEntry({ surface: 'x', reading: '' }), null);
});
test('レイヤーは1..10にクランプ', () => {
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', layer: 99 }).layer, 10);
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', layer: -5 }).layer, 1);
});
test('適用順はレイヤー降順→表記の長い順', () => {
  const list = normalizeList([
    { surface: 'あい', reading: 'ア', layer: 5 },
    { surface: 'あいうえ', reading: 'イ', layer: 5 },
    { surface: 'x', reading: 'ウ', layer: 9 },
  ]);
  assert.deepEqual(list.map((e) => e.surface), ['x', 'あいうえ', 'あい']);
});

// 受け入れテスト §20.3: 「斎藤ひとし」をレイヤー6、「斎」をレイヤー5 に登録すると、
// 「斎藤ひとし」は壊れず、単独の「斎」だけが置換される。
test('上のレイヤーで置換済みの領域は下のレイヤーが触らない', () => {
  const dict = [
    { surface: '斎藤ひとし', reading: 'さいとうひとし', layer: 6 },
    { surface: '斎', reading: 'ものいみ', layer: 5 },
  ];
  assert.equal(prepare('斎藤ひとしと斎', dict).text, 'サイトウヒトシとモノイミ');
});
test('読みはカタカナへ正規化される', () =>
  assert.equal(prepare('斎', [{ surface: '斎', reading: 'いつき' }]).text, 'イツキ'));
test('パターンは捕捉参照が使える', () =>
  assert.equal(prepare('第12話', [{ surface: '第(\\d+)話', reading: 'ダイ$1ワ', kind: 'pattern' }]).text, 'ダイ12ワ'));
test('壊れた正規表現の行は無視される(落ちない)', () =>
  assert.equal(prepare('abc', [{ surface: '(', reading: 'X', kind: 'pattern' }]).text, 'abc'));
test('語の $ は捕捉参照と誤解されない', () =>
  assert.equal(prepare('A', [{ surface: 'A', reading: '$1' }]).text, '$1'));

// --- 区切りの数え方(挿入した境界だけを無音化するための序数) ---
test('文頭・文末の区切りはポーズを生まない', () =>
  assert.deepEqual(gapRuns('、あい。'), []));
test('連続した区切りは1つに潰れる', () =>
  assert.deepEqual(gapRuns('あ、。い'), ['、。']));
test('改行はポーズも読みも生まない', () =>
  assert.deepEqual(gapRuns('あ\n、\nい'), ['、']));
test('境界挿入は空白だけの区切りとして無音化対象になる', () => {
  const r = prepare('東京都', [{ surface: '東京', reading: 'トウキョウ', padsBoundary: true }]);
  assert.equal(r.text.includes(BOUNDARY), false);   // マーカーは半角空白へ落とす
  assert.equal(r.text, ' トウキョウ 都');
  assert.deepEqual(r.silenceGaps, [0]);             // 先頭の空白は前に読む字が無いので数えない…
  assert.equal(r.gapCount, 1);                      // …数えるのは「トウキョウ」と「都」の間だけ
});
test('読点が隣接する境界は無音化しない(本来のポーズを尊重)', () => {
  const r = prepare('東京、都', [{ surface: '東京', reading: 'トウキョウ', padsBoundary: true }]);
  assert.deepEqual(r.silenceGaps, []);
});

// --- 向きの判定(縦書き/横書きと操作方向) ---
// 実在する壊れ方をそのままケースにしてある。制作現場では Kindle で見えたテンプレートが
// 検証されないまま使い回されるので、宣言と実際の組版が食い違う本が流通している。
const VERT = { vertical: true, rtl: true };
const HORIZ = { vertical: false, rtl: false };

test('宣言: primary-writing-mode が縦書き', () =>
  assert.equal(declaresVertical({ primaryWritingMode: 'vertical-rl' }), true));
test('宣言: 右綴じ+日本語は縦書き本とみなす', () =>
  assert.equal(declaresVertical({ dir: 'rtl', languages: ['ja'] }), true));
test('宣言: 左綴じの日本語は横書き本', () =>
  assert.equal(declaresVertical({ dir: 'ltr', languages: ['ja'] }), false));
test('宣言: 右綴じでもアラビア語は縦書きではない', () =>
  assert.equal(declaresVertical({ dir: 'rtl', languages: ['ar'] }), false));
test('宣言: 手掛かりが何も無ければ横書き', () =>
  assert.equal(declaresVertical({}), false));

test('補正: 縦書き宣言 + 横書きで組まれた → 補正する', () =>
  assert.equal(shouldAutoVertical({ mode: 'auto', declared: true, renderedVertical: false }), true));
test('補正: 本のCSSで既に縦書き → 触らない', () =>
  assert.equal(shouldAutoVertical({ mode: 'auto', declared: true, renderedVertical: true }), false));
test('補正: 判定不能(本文がまだ無い) → 触らない', () =>
  assert.equal(shouldAutoVertical({ mode: 'auto', declared: true, renderedVertical: null }), false));
test('補正: ユーザーが横書きを明示中 → 触らない', () =>
  assert.equal(shouldAutoVertical({ mode: 'horizontal', declared: true, renderedVertical: false }), false));
test('補正: 固定レイアウトは組み直さない', () =>
  assert.equal(shouldAutoVertical({ mode: 'auto', declared: true, renderedVertical: false, fixedLayout: true }), false));

test('適用モード: auto+補正なし → 本のCSSに任せる', () =>
  assert.equal(resolveWritingMode({ mode: 'auto', autoVertical: false }), 'auto'));
test('適用モード: auto+補正あり → 縦書きを注入', () =>
  assert.equal(resolveWritingMode({ mode: 'auto', autoVertical: true }), 'vertical'));
test('適用モード: 明示指定は補正より優先', () =>
  assert.equal(resolveWritingMode({ mode: 'horizontal', autoVertical: true }), 'horizontal'));

test('操作方向: 縦書きで組まれていれば rtl', () =>
  assert.equal(resolveDir({ mode: 'auto', rendered: VERT, naturalDir: 'rtl' }), 'rtl'));
test('操作方向: 右綴じ宣言でも横書きで組まれたら ltr', () =>
  assert.equal(resolveDir({ mode: 'auto', rendered: HORIZ, naturalDir: 'rtl' }), 'ltr'));
test('操作方向: 横書きでも direction:rtl(アラビア語等)なら rtl', () =>
  assert.equal(resolveDir({ mode: 'auto', rendered: { vertical: false, rtl: true }, naturalDir: 'rtl' }), 'rtl'));
test('操作方向: 本文がまだ無ければ本の綴じ方向で暫定', () =>
  assert.equal(resolveDir({ mode: 'auto', rendered: null, naturalDir: 'rtl' }), 'rtl'));
test('操作方向: 強制縦書きは組版より優先', () =>
  assert.equal(resolveDir({ mode: 'vertical', rendered: HORIZ, naturalDir: 'ltr' }), 'rtl'));
test('操作方向: 強制横書きは組版より優先', () =>
  assert.equal(resolveDir({ mode: 'horizontal', rendered: VERT, naturalDir: 'rtl' }), 'ltr'));


// --- 綴じ方向の状態機械(§8.4) ---
test('綴じ方向の巡回 auto→rtl→ltr→auto', () => {
  assert.equal(nextBinding('auto'), 'rtl');
  assert.equal(nextBinding('rtl'), 'ltr');
  assert.equal(nextBinding('ltr'), 'auto');
});
test('強制指定は即確定', () =>
  assert.deepEqual(initialBookDir({ forcedBinding: 'ltr', ppd: 'rtl' }), { dir: 'ltr', confirmed: true }));
test('OPF が縦書きを宣言していれば右綴じで確定', () =>
  assert.deepEqual(initialBookDir({ forcedBinding: 'auto', writingMode: 'auto', hint: 'vertical-rl', ppd: 'ltr' }),
    { dir: 'rtl', confirmed: true }));
test('手掛かりが ppd だけなら暫定値', () =>
  assert.deepEqual(initialBookDir({ forcedBinding: 'auto', writingMode: 'auto', hint: null, ppd: 'rtl' }),
    { dir: 'rtl', confirmed: false }));
// 実害の記録: 章ごとの向きで決めると、縦書き本でも横組みの前付けにいる間だけ左右が反転し、
// 表紙と本文1ページ目を往復するだけで奥付へ到達できなくなる。
test('横組みの表紙・前付けでは ltr を確定しない', () => {
  const s0 = { dir: 'rtl', confirmed: false };
  const s1 = noteSectionDirection(s0, { forcedBinding: 'auto', sectionDir: 'ltr', frontMatter: true, evidence: true });
  assert.deepEqual(s1, s0);
});
test('本文が横組みなら ppd は残骸だったと判断して ltr 確定', () => {
  const s1 = noteSectionDirection({ dir: 'rtl', confirmed: false },
    { forcedBinding: 'auto', sectionDir: 'ltr', frontMatter: false, evidence: true });
  assert.deepEqual(s1, { dir: 'ltr', confirmed: true });
});
test('絵だけの面(証拠なし)は向きの根拠にしない', () => {
  const s0 = { dir: 'rtl', confirmed: false };
  assert.deepEqual(noteSectionDirection(s0,
    { forcedBinding: 'auto', sectionDir: 'ltr', frontMatter: false, evidence: false }), s0);
});
test('縦書き/RTL を一度でも見たら右綴じで確定', () =>
  assert.deepEqual(noteSectionDirection({ dir: 'ltr', confirmed: true },
    { forcedBinding: 'auto', sectionDir: 'rtl' }), { dir: 'rtl', confirmed: true }));

// --- 組版補正(§8.3 / §8.12 / §8.13) ---
test('OPF ヒントの CSS は EBPAJ クラスを持つ文書に効かせない', () => {
  const css = opfHintCSS('vertical-rl');
  assert.ok(css.includes(':not(.vrtl)'));
  assert.equal(opfHintCSS(''), '');
});
test('書字方向ヒントの正規化', () => {
  assert.equal(normalizeWritingHint('vertical-rl'), 'vertical-rl');
  assert.equal(normalizeWritingHint('vertical'), 'vertical-rl');
  assert.equal(normalizeWritingHint('よくわからない値'), null);
});
test('ぶら下げ: 対の padding があれば行頭側へ入れ直す', () => {
  // 縦書き前提の text-indent:-79px + padding-top:79px を横書きで描くケース
  const fix = hangingFix({ indent: -79, vertical: false, rtl: false, padding: { top: 79, right: 0, bottom: 0, left: 0 } });
  assert.deepEqual(fix, { side: 'left', value: 79 });
});
test('ぶら下げ: 既に行頭側にあるなら触らない', () =>
  assert.equal(hangingFix({ indent: -79, vertical: true, rtl: false, padding: { top: 79, right: 0, bottom: 0, left: 0 } }), null));
test('ぶら下げ: 対を持たない負インデントは本来のぶら下げ組みなので触らない', () =>
  assert.equal(hangingFix({ indent: -20, vertical: false, rtl: false, padding: { top: 0, right: 0, bottom: 0, left: 0 } }), null));
test('目次のリンク切れ: ファイル名で拾い直す', () =>
  assert.equal(guessSectionFor({ href: 'text/c3.xhtml#x', sectionHrefs: ['c1.xhtml', 'text/c3.xhtml'], pos: 5 }), 1));
test('目次のリンク切れ: 先頭項目は spine 先頭(表紙)へ', () =>
  assert.equal(guessSectionFor({ href: 'gone.xhtml', sectionHrefs: ['c1.xhtml'], pos: 0 }), 0));
test('目次のリンク切れ: 直前の解決できる項目の次の章へ送る', () =>
  assert.equal(guessSectionFor({
    href: 'gone.xhtml', sectionHrefs: ['c1.xhtml', 'c2.xhtml', 'c3.xhtml'],
    tocHrefs: ['c1.xhtml', 'gone.xhtml'], pos: 1,
  }), 1));
test('href のファイル名はクエリ・フラグメントを外す', () =>
  assert.equal(hrefFileName('a/b/C3.xhtml?v=1#frag'), 'c3.xhtml'));

// --- 全体既定と本ごとの上書き(§15.3) ---
test('本ごとの指定があればそれを使う', () =>
  assert.equal(resolvePref({ binding: 'rtl' }, { binding: 'auto' }, 'binding'), 'rtl'));
test('既定と同じ値にしたら本ごとの指定は持たない(あとで既定に追従させるため)', () =>
  assert.deepEqual(setPref({ binding: 'rtl' }, { binding: 'auto' }, 'binding', 'auto'), {}));
test('判型は本ごとにしか持たない', () =>
  assert.deepEqual(setPref({}, { aspect: '3:4' }, 'aspect', '3:4'), { aspect: '3:4' }));
test('既定と同値になった本ごとの指定は読み込み時に捨てる(自己修復)', async () => {
  // storeGet はブラウザ/Tauri 依存なので、ここでは pruning の規則だけを直接確かめる
  const raw = { writingMode: 'auto', binding: 'rtl', aspect: '3:4' };
  const globals = { writingMode: 'auto', binding: 'auto', aspect: '3:4' };
  const pruned = Object.fromEntries(Object.entries(raw)
    .filter(([k, v]) => BOOK_ONLY_KEYS.includes(k) || globals[k] !== v));
  assert.deepEqual(pruned, { binding: 'rtl', aspect: '3:4' });
});
test('見開きの巡回 auto→always→never→auto', () => {
  assert.equal(nextSpread('auto'), 'always');
  assert.equal(nextSpread('never'), 'auto');
});
test('判型のパースと文字列化', () => {
  assert.deepEqual(parseAspect('844:1200'), { width: 844, height: 1200 });
  assert.deepEqual(parseAspect('1.5'), { width: 1.5, height: 1 });
  assert.equal(parseAspect('0:3'), null);
  assert.equal(aspectToString({ width: 843.6, height: 1200 }), '844:1200');
});

// --- 対訳(§13.6) ---
test('思考タグを落とす', () =>
  assert.equal(cleanCompletion('<think>ぐるぐる</think>訳文'), '訳文'));
test('閉じないまま切れた思考タグは以降を全部落とす', () =>
  assert.equal(cleanCompletion('訳文<think>途中で'), '訳文'));
test('行頭のラベルは1つだけ剥がす', () =>
  assert.equal(cleanCompletion('Translation: Hello'), 'Hello'));
test('全体を囲む引用符を外す(内側に閉じ記号があるときは外さない)', () => {
  assert.equal(cleanCompletion('「こんにちは」'), 'こんにちは');
  assert.equal(cleanCompletion('「あ」と「い」'), '「あ」と「い」');
});
test('文脈つきプロンプトは訳す部分を明示する', () => {
  const p = userPrompt('本文', '直前');
  assert.ok(p.includes('Do NOT translate'));
  assert.ok(p.endsWith('本文'));
  assert.equal(userPrompt('本文', ''), '本文');
});
test('キャッシュキーはモデル・言語・原文で変わる', () => {
  assert.notEqual(cacheKey('m1', 'ja', 'x'), cacheKey('m2', 'ja', 'x'));
  assert.notEqual(cacheKey('m1', 'ja', 'x'), cacheKey('m1', 'en', 'x'));
  assert.equal(cacheKey('m1', 'ja', 'x'), cacheKey('m1', 'ja', 'x'));
});


// --- 分類(コレクション) ---
const C = [
  { id: 'a', name: '小説', parentID: null, order: 0 },
  { id: 'b', name: 'SF', parentID: 'a', order: 0 },
  { id: 'c', name: '海外', parentID: 'b', order: 0 },
  { id: 'd', name: '画集', parentID: null, order: 1 },
];
test('子孫を全部集める', () =>
  assert.deepEqual([...col.selfAndDescendants('a', C)].sort(), ['a', 'b', 'c']));
test('親子が輪でも止まる', () => {
  const loop = [
    { id: 'x', name: 'X', parentID: 'y', order: 0 },
    { id: 'y', name: 'Y', parentID: 'x', order: 0 },
  ];
  assert.deepEqual([...col.selfAndDescendants('x', loop)].sort(), ['x', 'y']);
});
test('自分の子孫は親に選べない判定', () => {
  assert.equal(col.isDescendant('c', 'a', C), true);
  assert.equal(col.isDescendant('a', 'c', C), false);
});
test('畳んだ分だけ行が減る', () => {
  assert.equal(col.rows(C, new Set()).length, 2);              // 小説 / 画集
  assert.equal(col.rows(C, new Set(['a'])).length, 3);         // + SF
  assert.equal(col.rows(C, new Set(['a', 'b'])).length, 4);    // + 海外
});
test('上からの道筋', () => assert.equal(col.pathName('c', C), '小説 / SF / 海外'));
test('分類を消すと子は親へ繰り上がる', () => {
  const after = col.removing('b', C);
  assert.equal(after.find((x) => x.id === 'c').parentID, 'a');
  assert.equal(after.some((x) => x.id === 'b'), false);
});
test('壊れた分類は立て直す(名前なし・親が居ない・自分が親)', () => {
  const fixed = col.normalizeCollections([
    { id: '1', name: 'ok', parentID: 'nope' },
    { id: '2', name: '  ' },
    { id: '3', name: 'self', parentID: '3' },
    { id: '1', name: 'dup' },
    { name: 'no id' },
  ]);
  assert.deepEqual(fixed.map((c) => c.id), ['1', '3']);
  assert.equal(fixed[0].parentID, null);   // 親が居ない → 最上位へ
  assert.equal(fixed[1].parentID, null);   // 自分が親 → 最上位へ
});
test('スコープで絞る(分類は子孫も含む)', () => {
  const books = [
    { id: 'p', favorite: true, collections: ['c'] },
    { id: 'q', collections: [] },
    { id: 'r', collections: ['d'] },
  ];
  assert.deepEqual(col.booksInScope(books, 'collection:a', C).map((b) => b.id), ['p']);
  assert.deepEqual(col.booksInScope(books, col.SCOPE_FAVORITES, C).map((b) => b.id), ['p']);
  assert.deepEqual(col.booksInScope(books, col.SCOPE_UNFILED, C).map((b) => b.id), ['q']);
  assert.equal(col.booksInScope(books, col.SCOPE_ALL, C).length, 3);
});
test('冊数バッジは子孫ぶんも数える', () => {
  const books = [{ id: 'p', collections: ['c'] }, { id: 'r', collections: ['d'] }];
  const n = col.shelfCounts(books, C);
  assert.equal(n['collection:a'], 1);
  assert.equal(n['collection:d'], 1);
  assert.equal(n[col.SCOPE_ALL], 2);
});
test('未知のスコープ文字列はすべてに倒す', () => {
  assert.equal(col.parseScope('collection:'), 'all');
  assert.equal(col.parseScope(null), 'all');
  assert.equal(col.parseScope('collection:x'), 'collection:x');
});

// --- 書棚(プロファイル) ---
test('壊れた一覧でも既定書棚は必ず在る', () => {
  const i = normalizeIndex({ profiles: [], currentID: 'gone' }, 'Library');
  assert.equal(i.profiles.length, 1);
  assert.equal(i.profiles[0].id, PRIMARY_ID);
  assert.equal(i.currentID, PRIMARY_ID);   // 行き先が無ければ既定へ戻す
});
test('ID の重複は後から来たほうを捨てる', () => {
  const i = normalizeIndex({ profiles: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }] }, 'L');
  assert.equal(i.profiles.filter((p) => p.id === 'x').length, 1);
  assert.equal(i.profiles.find((p) => p.id === 'x').name, 'A');
});
test('名前が空の書棚には既定名を入れる', () => {
  const i = normalizeIndex({ profiles: [{ id: PRIMARY_ID, name: ' ' }, { id: 'y', name: '' }] }, '本棚');
  assert.equal(i.profiles.find((p) => p.id === PRIMARY_ID).name, '本棚');
  assert.equal(i.profiles.find((p) => p.id === 'y').name, 'Shelf');
});
test('名前が空なら書棚を作らない', () => {
  const { profile } = addProfile(initialIndex('L'), '   ');
  assert.equal(profile, null);
});
test('既定書棚と表示中の書棚は消せない', () => {
  let i = initialIndex('L');
  ({ index: i } = addProfile(i, '仕事', 'w'));
  assert.equal(canRemoveProfile(i, PRIMARY_ID), false);
  assert.equal(canRemoveProfile(i, 'w'), true);
  const cur = { ...i, currentID: 'w' };
  assert.equal(canRemoveProfile(cur, 'w'), false);
  assert.equal(removeProfile(i, 'w').ok, true);
  assert.equal(removeProfile(i, PRIMARY_ID).ok, false);
});
test('改名は空文字を拒む', () => {
  let i = initialIndex('L');
  ({ index: i } = addProfile(i, '仕事', 'w'));
  assert.equal(renameProfile(i, 'w', '  ').ok, false);
  assert.equal(renameProfile(i, 'w', '私用').index.profiles.find((p) => p.id === 'w').name, '私用');
});
test('既定書棚のキーは従来のまま・増やした書棚だけ接尾辞が付く', () => {
  assert.equal(scopedKey('library', PRIMARY_ID), 'library');
  assert.equal(scopedKey('library', 'w'), 'library#w');
  // 書棚ごとに分けるキーの一覧に、蔵書・分類・辞書・共通CSS が入っていること
  for (const k of ['library', 'collections', 'dict', 'userCSS']) assert.ok(SCOPED_KEYS.includes(k));
  assert.equal(SCOPED_KEYS.includes('settings'), false); // 機械の設定は分けない
});

// --- 自動ページ送り ---
function fakePager(opts = {}) {
  let now = 0;
  const target = {
    speaking: false, frac: 0, turns: 0,
    isSpeaking: () => target.speaking,
    progression: () => target.frac,
    advance: async () => { target.turns++; if (target.advances) target.frac = target.advances(); },
    note: () => { target.noted = true; },
  };
  const pager = new AutoPager({
    target: () => (opts.gone ? null : target),
    now: () => now,
    sleep: async () => {},
    seconds: 10,
    ...opts,
  });
  return { pager, target, advance: (ms) => { now += ms; } };
}
test('間隔ちょうどで1ページ送る', async () => {
  const { pager, target, advance } = fakePager();
  target.advances = () => target.frac + 0.1;
  pager.start(10);
  advance(9000); pager.tick();
  assert.equal(target.turns, 0);
  advance(1000); await pager.tick();
  assert.equal(target.turns, 1);
  pager.stop();
});
test('読み上げ中は送らずに数え直す', async () => {
  const { pager, target, advance } = fakePager();
  pager.start(10);
  target.speaking = true;
  advance(10000); await pager.tick();
  assert.equal(target.turns, 0);
  assert.equal(pager.isHolding, true);
  // 読み上げが終わっても、まる1間隔ぶん待ってから送る
  target.speaking = false;
  advance(9000); await pager.tick();
  assert.equal(target.turns, 0);
  advance(1000); await pager.tick();
  assert.equal(target.turns, 1);
  pager.stop();
});
test('本の終わりで自分から止まる', async () => {
  const { pager, target, advance } = fakePager();
  target.frac = END_THRESHOLD + 0.01;
  target.advances = () => target.frac;      // 送っても動かない
  pager.start(10);
  advance(10000); await pager.tick();
  assert.equal(pager.isRunning, false);
  assert.equal(target.noted, true);
});
test('途中で位置が動かなくても止めない(描画待ちのことがある)', async () => {
  const { pager, target, advance } = fakePager();
  target.frac = 0.5;
  target.advances = () => target.frac;
  pager.start(10);
  advance(10000); await pager.tick();
  assert.equal(pager.isRunning, true);
  pager.stop();
});
test('手動で送ったら間隔を頭から数え直す', async () => {
  const { pager, target, advance } = fakePager();
  target.advances = () => target.frac + 0.1;
  pager.start(10);
  advance(9000);
  pager.noteManualTurn();
  advance(9000); await pager.tick();
  assert.equal(target.turns, 0);            // 数え直したのでまだ来ない
  advance(1000); await pager.tick();
  assert.equal(target.turns, 1);
  pager.stop();
});
test('本を閉じたら止まる', () => {
  const { pager } = fakePager();
  pager.start(10);
  pager._target = () => null;
  pager.tick();
  assert.equal(pager.isRunning, false);
});

// --- スリープタイマー ---
test('残り時間の書式(1時間以上は h:mm:ss)', () => {
  assert.equal(formatRemaining(65), '1:05');
  assert.equal(formatRemaining(3725), '1:02:05');
  assert.equal(formatRemaining(-5), '0:00');
});
test('未知の動作は「読み上げを停止」に倒す', () => {
  assert.equal(normalizeAction('nope'), 'stopOnly');
  assert.equal(normalizeAction('shutdown'), 'shutdown');
});
function fakeTimer(action = 'stopOnly') {
  let now = 0;
  let stopped = 0;
  const power = recordingPower();
  const timer = new SleepTimer({
    now: () => now, power, action,
    onExpire: () => { stopped++; },
  });
  return { timer, power, stops: () => stopped, advance: (ms) => { now += ms; } };
}
test('満了で読み上げを止める(追加動作なし)', () => {
  const { timer, power, stops, advance } = fakeTimer('stopOnly');
  timer.start(1);
  advance(60000); timer.tick();
  assert.equal(stops(), 1);
  assert.equal(power.lastRequest, null);
  assert.equal(timer.isActive, false);
});
test('スリープは停止してから電源を触る', () => {
  const { timer, power, stops, advance } = fakeTimer('sleepSystem');
  timer.start(1);
  advance(60000); timer.tick();
  assert.equal(stops(), 1);
  assert.equal(power.lastRequest, 'sleep');
});
test('シャットダウンは猶予を挟み、取り消せる', () => {
  const { timer, power, advance } = fakeTimer('shutdown');
  timer.start(1);
  advance(60000); timer.tick();
  assert.equal(power.lastRequest, null);              // まだ落とさない
  assert.equal(Math.round(timer.shutdownCountdown), SHUTDOWN_GRACE);
  assert.equal(timer.cancelShutdownCountdown(), true);
  advance(60000); timer.tick();
  assert.equal(power.lastRequest, null);              // 取り消したので落ちない
});
test('猶予が切れたらシャットダウンする', () => {
  const { timer, power, advance } = fakeTimer('shutdown');
  timer.start(1);
  advance(60000); timer.tick();
  advance(SHUTDOWN_GRACE * 1000); timer.tick();
  assert.equal(power.lastRequest, 'shutdown');
});
test('延長は締め切りをずらすだけで動作を変えない', () => {
  const { timer, stops, advance } = fakeTimer('stopOnly');
  timer.start(1);
  advance(50000); timer.tick();
  timer.extend(1);
  advance(10000); timer.tick();
  assert.equal(stops(), 0);
  advance(60000); timer.tick();
  assert.equal(stops(), 1);
});
test('解除すれば満了しない', () => {
  const { timer, stops, advance } = fakeTimer('stopOnly');
  timer.start(1);
  timer.cancel();
  advance(120000); timer.tick();
  assert.equal(stops(), 0);
});

// --- 画面をまたぐ引き継ぎ(書棚 ⇄ リーダー) ---
// 書棚とリーダーは別ページなので、締め切りの「時刻」だけを渡して引き直す。
// 実際の受け渡しは timers.js が sessionStorage で行う。ここではその中身を検証する。
test('締め切りを引き継いで復元できる', () => {
  const a = fakeTimer('stopOnly');
  a.timer.start(10);
  const snap = a.timer.snapshot();
  assert.equal(typeof snap.deadline, 'number');

  const b = fakeTimer('stopOnly');       // 遷移先の画面
  assert.equal(b.timer.restore(snap), true);
  assert.equal(b.timer.isActive, true);
  b.advance(10 * 60000); b.timer.tick();
  assert.equal(b.stops(), 1);            // 引き継いだ締め切りで満了する
});
test('過ぎた締め切りは復元しない(再起動で勝手に満了させない)', () => {
  const { timer, stops, advance } = fakeTimer('shutdown');
  // 「昨日掛けたタイマー」を復元しようとした状況。now=0 に対して締め切りは過去。
  assert.equal(timer.restore({ deadline: -1000 }), false);
  assert.equal(timer.isActive, false);
  advance(1000); timer.tick();
  assert.equal(stops(), 0);
});
test('シャットダウン猶予も引き継げる', () => {
  const a = fakeTimer('shutdown');
  a.timer.start(1);
  a.advance(60000); a.timer.tick();      // 満了 → 猶予に入る
  assert.ok(a.timer.shutdownCountdown > 0);

  const b = fakeTimer('shutdown');
  b.timer.restore(a.timer.snapshot());
  assert.ok(b.timer.shutdownCountdown > 0);
  assert.equal(b.timer.cancelShutdownCountdown(), true);   // 遷移先でも取り消せる
  assert.equal(b.power.lastRequest, null);
});
test('復元しても何も無ければ止まったまま', () => {
  const { timer } = fakeTimer('stopOnly');
  assert.equal(timer.restore({}), false);
  assert.equal(timer.restore(), false);
  assert.equal(timer.isActive, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

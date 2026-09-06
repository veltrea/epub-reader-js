// 純粋ロジックのテスト(DOM不要)。実行: node tests/logic.test.mjs
import assert from 'node:assert';
import { hiraganaToKatakana, katakanaToHiragana, gojuonSection } from '../src/app/kana.js';
import { normalizeEntry, normalizeList, prepare, gapRuns, findEntry, BOUNDARY, AT_WINDOW } from '../src/app/dictionary.js';
import {
  declaresVertical, shouldAutoVertical, resolveWritingMode, resolveDir,
  nextBinding, initialBookDir, noteSectionDirection,
} from '../src/app/writing-mode.js';
import { hangingFix, guessSectionFor, hrefFileName, osFileName, normalizeWritingHint, opfHintCSS } from '../src/app/typeset.js';
import { parseAspect, aspectToString, setPref, resolvePref, nextSpread, BOOK_ONLY_KEYS } from '../src/app/prefs.js';
import { cleanCompletion, cacheKey, userPrompt } from '../src/app/translate.js';
import * as col from '../src/app/collections.js';
import {
  PRIMARY_ID, normalizeIndex, initialIndex, addProfile, renameProfile,
  canRemoveProfile, removeProfile, scopedKey, SCOPED_KEYS,
} from '../src/app/profiles.js';
import { AutoPager, END_THRESHOLD } from '../src/app/autopager.js';
import { SleepTimer, formatRemaining, normalizeAction, recordingPower, SHUTDOWN_GRACE } from '../src/app/sleeptimer.js';
import { CELL, PALETTE, band, laneColors, r1, measureDocument, visibleViewport, nearestPalette, readRibbon } from '../src/app/measure.js';

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

// --- この場所だけの読み(位置 + 表記の二重チェック) ---
//
// 位置は「目印」で、当てはめる場所は表記の一致で決める。位置の数え方は道具ごとに違うので、
// そのまま信じると 1 文字ずれた場所を読み替えてしまう。だから両方でチェックする。
const AT = (offset, extra = {}) => ({
  surface: '行った', reading: 'オコナッタ', kind: 'word', layer: 9,
  at: { section: 0, offset, window: 40, ...extra },
});
// 「会議を行った。彼は学校へ行った。」——同じ「行った」が 2 つある文。
const TWO = '会議を行った。彼は学校へ行った。';

test('場所を決めた登録は、その場所の一致だけを読み替える', () => {
  // 1 つ目の「行った」は 3 文字目から。文の先頭が章の 100 文字目にあるとする。
  const r = prepare(TWO, [AT(103)], { section: 0, offset: 100 });
  assert.equal(r.text, '会議をオコナッタ。彼は学校へ行った。');
});

test('2 つ目の場所を指せば、2 つ目だけが読み替わる', () => {
  // 2 つ目の「行った」は 13 文字目から。
  const r = prepare(TWO, [AT(113)], { section: 0, offset: 100 });
  assert.equal(r.text, '会議を行った。彼は学校へオコナッタ。');
});

test('位置が多少ずれていても、いちばん近い一致を読み替える', () => {
  // 与えられた位置が 2 文字ずれている(本当は 103)。1 つ目(103)の方が 2 つ目(112)より近い。
  const r = prepare(TWO, [AT(105)], { section: 0, offset: 100 });
  assert.equal(r.text, '会議をオコナッタ。彼は学校へ行った。');
});

test('近くに同じ語が 2 つあっても、指定に近い方だけを読み替える', () => {
  // 窓(40)には 2 つとも入るが、読み替わるのは近い方だけ。
  assert.equal(prepare(TWO, [AT(103)], { section: 0, offset: 100 }).text,
    '会議をオコナッタ。彼は学校へ行った。');
  assert.equal(prepare(TWO, [AT(112)], { section: 0, offset: 100 }).text,
    '会議を行った。彼は学校へオコナッタ。');
});

test('窓の外なら読み替えない(離れた場所の同じ語を巻き込まない)', () => {
  const r = prepare(TWO, [AT(103, { window: 0 })], { section: 0, offset: 200 });
  assert.equal(r.text, TWO);
  assert.equal(r.changed, false);
});

test('章が違えば読み替えない', () => {
  const r = prepare(TWO, [AT(103, { section: 5 })], { section: 0, offset: 100 });
  assert.equal(r.text, TWO);
});

test('どこを読んでいるか分からないときは、場所を決めた登録を当てない', () => {
  assert.equal(prepare(TWO, [AT(103)]).text, TWO);
  assert.equal(prepare(TWO, [AT(103)], null).text, TWO);
});

test('場所を決めた登録は、場所なしの登録より先に当たる(同じレイヤーのとき)', () => {
  const list = normalizeList([
    { surface: '行った', reading: 'イッタ', kind: 'word', layer: 9 },
    { surface: '行った', reading: 'オコナッタ', kind: 'word', layer: 9, at: { section: 0, offset: 103 } },
  ]);
  assert.equal(list.length, 2, '場所つきと場所なしは別の登録として残る');
  assert.ok(list[0].at, '場所つきが先に並ぶ');
  const r = prepare(TWO, list, { section: 0, offset: 100 });
  // 1 つ目は場所つきの読み、2 つ目は場所なしの読みになる
  assert.equal(r.text, '会議をオコナッタ。彼は学校へイッタ。');
});

test('同じ表記でも、場所が違えば別の登録として残る', () => {
  const list = normalizeList([
    { surface: '行った', reading: 'オコナッタ', kind: 'word', at: { section: 0, offset: 103 } },
    { surface: '行った', reading: 'イッタ', kind: 'word', at: { section: 0, offset: 113 } },
  ]);
  assert.equal(list.length, 2);
  const r = prepare(TWO, list, { section: 0, offset: 100 });
  assert.equal(r.text, '会議をオコナッタ。彼は学校へイッタ。');
});

test('壊れた場所の指定は、場所なしの登録として扱う', () => {
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', at: {} }).at, undefined);
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', at: { section: -1, offset: 3 } }).at, undefined);
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', at: 'x' }).at, undefined);
});

test('窓の既定値は AT_WINDOW', () => {
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', at: { section: 0, offset: 3 } }).at.window, AT_WINDOW);
});

// --- 同じ表記が既に登録してあるかを探す(登録画面に前の読みを入れて出すため) ---
//
// 本文で語を選んで「登録」を押したとき、その語を前に登録していたら、新しく空の 1 件を
// 作らずに前の登録を開く。同じ表記が二重に並ぶと、どちらが効いているのか分からなくなる。

const L = (common, book = null) => ({ common, book });

test('同じ表記があれば、その場所を返す', () => {
  const lists = L([{ surface: '明日', reading: 'アシタ', kind: 'word' },
                   { surface: '東京都', reading: 'トウキョウト', kind: 'word' }]);
  assert.deepEqual(findEntry(lists, '東京都'), { scope: 'common', index: 1 });
});

test('同じ表記が無ければ null', () => {
  assert.equal(findEntry(L([{ surface: '明日', reading: 'アシタ', kind: 'word' }]), '東京都'), null);
});

test('「この本だけ」を先に見る(読み上げで使われるのがそちらのため)', () => {
  const lists = L([{ surface: '灰原', reading: 'ハイバラ', kind: 'word' }],
                  [{ surface: '灰原', reading: 'ハイハラ', kind: 'word' }]);
  assert.deepEqual(findEntry(lists, '灰原'), { scope: 'book', index: 0 });
});

test('この本だけの辞書が無いときは、すべての本を見る', () => {
  const lists = L([{ surface: '灰原', reading: 'ハイバラ', kind: 'word' }], null);
  assert.deepEqual(findEntry(lists, '灰原'), { scope: 'common', index: 0 });
});

test('パターンの登録は相手にしない(表記が正規表現のため)', () => {
  const lists = L([{ surface: '第(\\d+)話', reading: 'ダイ$1ワ', kind: 'pattern' }]);
  assert.equal(findEntry(lists, '第(\\d+)話'), null);
});

test('前後の条件が付いていない登録を先に選ぶ', () => {
  const lists = L([
    { surface: '行', reading: 'ギョウ', kind: 'word', before: 'kanji' },
    { surface: '行', reading: 'オコナ', kind: 'word' },
  ]);
  assert.deepEqual(findEntry(lists, '行'), { scope: 'common', index: 1 });
});

test('条件付きしか無ければ、その最初のものを選ぶ', () => {
  const lists = L([{ surface: '行', reading: 'ギョウ', kind: 'word', before: 'kanji' }]);
  assert.deepEqual(findEntry(lists, '行'), { scope: 'common', index: 0 });
});

test('場所を決めない登録を探すとき、場所付きの登録は選ばない', () => {
  const lists = L([{ surface: '行った', reading: 'オコナッタ', kind: 'word', at: { section: 0, offset: 100, window: 40 } }]);
  assert.equal(findEntry(lists, '行った'), null);
});

test('場所を決めて探すとき、探す範囲の中にあれば選ぶ', () => {
  const lists = L([], [{ surface: '行った', reading: 'オコナッタ', kind: 'word', at: { section: 0, offset: 100, window: 40 } }]);
  assert.deepEqual(findEntry(lists, '行った', { section: 0, offset: 120 }), { scope: 'book', index: 0 });
  assert.equal(findEntry(lists, '行った', { section: 0, offset: 200 }), null);   // 範囲の外
  assert.equal(findEntry(lists, '行った', { section: 1, offset: 100 }), null);   // 章が違う
});

test('場所を決めて探すとき、指定に近い方を選ぶ', () => {
  const lists = L([], [
    { surface: '行った', reading: 'ア', kind: 'word', at: { section: 0, offset: 100, window: 40 } },
    { surface: '行った', reading: 'イ', kind: 'word', at: { section: 0, offset: 130, window: 40 } },
  ]);
  assert.deepEqual(findEntry(lists, '行った', { section: 0, offset: 125 }), { scope: 'book', index: 1 });
});

test('表記が空なら探さない', () => {
  assert.equal(findEntry(L([{ surface: '明日', reading: 'アシタ', kind: 'word' }]), ''), null);
  assert.equal(findEntry(L([]), '明日'), null);
});

// --- 前後の条件(正規表現を書かずに指定する) ---
//
// 一文字の漢字を登録すると熟語まで読み替えてしまう(「行」を登録すると「銀行」も変わる)。
// before / after で「直前が漢字以外のときだけ」と言えれば、正規表現を知らなくても防げる。
const W = (extra) => ({ surface: '行', reading: 'オコナ', kind: 'word', layer: 5, ...extra });

test('直前がひらがなのときだけ読み替える', () => {
  const e = { surface: '行った', reading: 'オコナッタ', kind: 'word', layer: 5, before: 'kana' };
  assert.equal(prepare('とり行った', [e]).text, 'とりオコナッタ');
  assert.equal(prepare('銀行った', [e]).text, '銀行った');
});

test('直前が漢字以外のときだけ読み替える(熟語を巻き込まない)', () => {
  assert.equal(prepare('銀行と旅行、行った', [W({ before: 'notKanji' })]).text, '銀行と旅行、オコナった');
});

test('直後の条件も指定できる', () => {
  assert.equal(prepare('行事と行った', [W({ after: 'notKanji' })]).text, '行事とオコナった');
});

test('前後の両方を指定すると、その両方を満たすときだけ読み替える', () => {
  assert.equal(prepare('銀行と行事と、行く', [W({ before: 'notKanji', after: 'notKanji' })]).text,
    '銀行と行事と、オコナく');
});

test('カタカナ・漢字・数字も条件にできる', () => {
  assert.equal(prepare('ドル箱と箱', [{ surface: '箱', reading: 'ハコ', kind: 'word', layer: 5, before: 'kata' }]).text,
    'ドルハコと箱');
  assert.equal(prepare('五年と5年', [{ surface: '年', reading: 'ネン', kind: 'word', layer: 5, before: 'digit' }]).text,
    '五年と5ネン');
});

test('条件はパターンにも掛かる(選択があっても片方だけにならない)', () => {
  const e = { surface: '行|来', reading: 'X', kind: 'pattern', layer: 5, before: 'notKanji' };
  // 「銀行」「再来」の中の字は読み替えない。文頭の「行」と読点のあとの「来」だけ。
  assert.equal(prepare('行き、銀行、来た、再来', [e]).text, 'Xき、銀行、Xた、再来');
});

test('知らない条件と any は「条件なし」として扱う', () => {
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', before: 'any' }).before, undefined);
  assert.equal(normalizeEntry({ surface: 'a', reading: 'あ', before: 'zzz' }).before, undefined);
});

test('前後の条件が違えば別の登録として残る', () => {
  const list = normalizeList([
    { surface: '行', reading: 'オコナ', kind: 'word', before: 'kana' },
    { surface: '行', reading: 'ギョウ', kind: 'word', before: 'kanji' },
  ]);
  assert.equal(list.length, 2);
});

// --- パターンの読みで、捕捉した部分を展開する ---
//
// 「直前のひらがなはそのまま残し、漢字のところだけ読みに置き換える」を書けるようにする。
// 捕捉した部分はカタカナに直す(読みはカタカナで揃える約束のため)。
test('$1 に捕捉した部分が入り、カタカナに直る', () => {
  const e = { surface: '([ぁ-ん])行った', reading: '$1オコナッタ', kind: 'pattern', layer: 5 };
  assert.equal(prepare('とり行った', [e]).text, 'とリオコナッタ');
  assert.equal(prepare('会議を行った', [e]).text, '会議ヲオコナッタ');
});

test('当てはまらない前置きなら、そのまま読まれる', () => {
  const e = { surface: '([をがはに])行った', reading: '$1オコナッタ', kind: 'pattern', layer: 5 };
  assert.equal(prepare('学校へ行った', [e]).text, '学校へ行った');
});

test('捕捉が 2 つあっても、それぞれ入る', () => {
  const e = { surface: '([ぁ-ん])行([ぁ-ん])', reading: '$1ギョウ$2', kind: 'pattern', layer: 5 };
  assert.equal(prepare('あ行いう', [e]).text, 'アギョウイう');
});

test('$& は一致した全体を指す', () => {
  const e = { surface: '(その)通り', reading: '$&', kind: 'pattern', layer: 5 };
  assert.equal(prepare('その通り', [e]).text, 'ソノ通リ');
});

// 後読み・先読みは「条件にするだけで、置き換えには含めない」書き方。
// これが無いと、直前の文字を捕まえて $1 で書き戻すしかなく、書くのが面倒になる。
test('後読みで、直前がひらがなのときだけ読み替える', () => {
  const e = { surface: '(?<=[ぁ-ん])行った', reading: 'オコナッタ', kind: 'pattern', layer: 5 };
  assert.equal(prepare('とり行った', [e]).text, 'とりオコナッタ');
  assert.equal(prepare('銀行った', [e]).text, '銀行った');
});

test('否定の後読みで、熟語の中の字を巻き込まない', () => {
  const e = { surface: '(?<![一-龥])行', reading: 'オコナ', kind: 'pattern', layer: 5 };
  assert.equal(prepare('銀行と旅行、行った', [e]).text, '銀行と旅行、オコナった');
});

test('先読みで、直後を条件にする', () => {
  const e = { surface: '行(?=事)', reading: 'ギョウ', kind: 'pattern', layer: 5 };
  assert.equal(prepare('行事と行った', [e]).text, 'ギョウ事と行った');
});

test('後読みと捕捉を混ぜても、番号はずれない', () => {
  const e = { surface: '(?<=、)([ぁ-ん]+)行った', reading: '$1オコナッタ', kind: 'pattern', layer: 5 };
  assert.equal(prepare('さて、とり行った', [e]).text, 'さて、トリオコナッタ');
  assert.equal(prepare('とり行った', [e]).text, 'とり行った');
});

test('$$ は $ そのもの', () => {
  const e = { surface: 'ドル', reading: '$$', kind: 'pattern', layer: 5 };
  assert.equal(prepare('ドル', [e]).text, '$');
});

test('語(パターンでない)の読みに $1 と書いても、そのまま $1 と読まれる', () => {
  const e = { surface: '行った', reading: '$1オコナッタ', kind: 'word', layer: 5 };
  assert.equal(prepare('行った', [e]).text, '$1オコナッタ');
});

// --- 辞書を 2 つ重ねる(すべての本 + この本だけ) ---
//
// 読み上げに渡すときは [...すべての本, ...この本だけ] の順に並べる。
// normalizeList が「種類 + 表記」をキーに後勝ちで畳むので、同じ表記があれば
// この本の側が勝つ。並べ替えは畳んだあとなので、レイヤーの指定はそのまま効く。
const mergeDicts = (common, book) => normalizeList([...common, ...book]);

test('同じ表記が両方にあれば、この本だけの登録が勝つ', () => {
  const list = mergeDicts(
    [{ surface: '斎藤', reading: 'サイトウ', layer: 5 }],
    [{ surface: '斎藤', reading: 'サイドウ', layer: 5 }],
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].reading, 'サイドウ');
});

test('種類が違えば別の登録として残る(語とパターン)', () => {
  const list = mergeDicts(
    [{ surface: '斎藤', reading: 'サイトウ', kind: 'word' }],
    [{ surface: '斎藤', reading: 'サイドウ', kind: 'pattern' }],
  );
  assert.equal(list.length, 2);
});

test('この本だけの登録が上のレイヤーなら、先に適用される', () => {
  const list = mergeDicts(
    [{ surface: '斎藤', reading: 'サイトウ', layer: 5 }],
    [{ surface: '斎藤太郎', reading: 'サイトウタロウ', layer: 7 }],
  );
  assert.deepEqual(list.map((e) => e.surface), ['斎藤太郎', '斎藤']);
  assert.equal(prepare('斎藤太郎と斎藤', list).text, 'サイトウタロウとサイトウ');
});

test('この本だけが空でも、すべての本の登録がそのまま効く', () => {
  const list = mergeDicts([{ surface: '明日', reading: 'アシタ', layer: 8 }], []);
  assert.equal(prepare('明日', list).text, 'アシタ');
});

test('すべての本が空でも、この本だけの登録が効く', () => {
  const list = mergeDicts([], [{ surface: '明日', reading: 'ミョウニチ', layer: 8 }]);
  assert.equal(prepare('明日', list).text, 'ミョウニチ');
});

test('この本だけの登録を消すと、すべての本の読みに戻る', () => {
  const common = [{ surface: '斎藤', reading: 'サイトウ', layer: 5 }];
  assert.equal(prepare('斎藤', mergeDicts(common, [{ surface: '斎藤', reading: 'サイドウ', layer: 5 }])).text, 'サイドウ');
  assert.equal(prepare('斎藤', mergeDicts(common, [])).text, 'サイトウ');
});

test('この本だけで無効にしても、すべての本の登録は復活しない(後勝ちで畳むため)', () => {
  const list = mergeDicts(
    [{ surface: '斎藤', reading: 'サイトウ', layer: 5 }],
    [{ surface: '斎藤', reading: 'サイドウ', layer: 5, enabled: false }],
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].enabled, false);
  assert.equal(prepare('斎藤', list).text, '斎藤');
});

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

// OS のファイルパスからファイル名を取り出す。Windows は `\` 区切りなので、
// `/` だけで切るとフルパスがそのまま名前になってしまう。
test('Windows のパスからファイル名を取り出す', () =>
  assert.equal(osFileName('D:\\books\\本.epub'), '本.epub'));
test('macOS・Linux のパスからファイル名を取り出す', () =>
  assert.equal(osFileName('/home/reader/books/本.epub'), '本.epub'));
test('Windows で `/` 区切りを使っていても取り出せる', () =>
  assert.equal(osFileName('D:/books/本.epub'), '本.epub'));
test('区切りが混ざっていても、いちばん後ろの名前を取る', () =>
  assert.equal(osFileName('D:\\books/sub\\本.epub'), '本.epub'));
test('区切りが無ければそのまま返す', () =>
  assert.equal(osFileName('本.epub'), '本.epub'));
test('空の文字列を渡しても失敗しない', () => assert.equal(osFileName(''), ''));

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

// --- 測定オーバーレイ(§14.1・§14.4) ---
// 色の並びと符号化を変えると、元アプリで撮った写真と比べられなくなる。数で固定しておく。
test('パレットは16色', () => assert.equal(PALETTE.length, 16));
test('パレットの先頭と末尾は元アプリと同じ', () => {
  assert.equal(PALETTE[0], '#E6194B');
  assert.equal(PALETTE[15], '#A9A9A9');
});
test('1セルは10px', () => assert.equal(CELL, 10));

test('band 0px → セル0・下0・上0', () => assert.deepEqual(band(0), { cell: 0, low: 0, high: 0 }));
test('band 150px → セル15・下15・上0', () => assert.deepEqual(band(150), { cell: 15, low: 15, high: 0 }));
test('band 160px → セル16・下0・上1(桁が繰り上がる)', () => assert.deepEqual(band(160), { cell: 16, low: 0, high: 1 }));
test('band 2550px → セル255・下15・上15(読める上限)', () => assert.deepEqual(band(2550), { cell: 255, low: 15, high: 15 }));
test('band 2560px → セル256・下0・上0(一周して戻る)', () => assert.deepEqual(band(2560), { cell: 256, low: 0, high: 0 }));
test('bandは四捨五入する', () => assert.equal(band(154).cell, 15));
test('band は負でも色番号が0〜15に収まる', () => {
  const b = band(-10);
  assert.equal(b.cell, -1);
  assert.ok(b.low >= 0 && b.low < 16);
  assert.ok(b.high >= 0 && b.high < 16);
});

test('高位×16+低位で元のセル番号に戻る', () => {
  for (const cell of [0, 1, 15, 16, 17, 99, 128, 255]) {
    const b = band(cell * CELL);
    assert.equal(b.high * 16 + b.low, cell, 'cell=' + cell);
  }
});
test('セル99の2レーンの色(仕様書の例)', () => {
  // §14.4 の例は cell:99, low:3, high:6
  assert.deepEqual(band(990), { cell: 99, low: 3, high: 6 });
  assert.deepEqual(laneColors(99), { low: PALETTE[3], high: PALETTE[6] });
});
test('小数第1位に丸める', () => {
  assert.equal(r1(12.54), 12.5);
  assert.equal(r1(12.55), 12.6);
  assert.equal(r1(0), 0);
});

test('visualViewport があればそちらを使う', () => {
  const win = { innerWidth: 4000, innerHeight: 680, visualViewport: { width: 1000.4, height: 680 } };
  assert.deepEqual(visibleViewport(win), { w: 1000, h: 680 });
});
test('visualViewport が無ければ innerWidth を使う', () => {
  assert.deepEqual(visibleViewport({ innerWidth: 800, innerHeight: 600 }), { w: 800, h: 600 });
});

test('measureDocument は仕様書§14.4の形で返す', () => {
  // DOM は使わない。querySelectorAll と getBoundingClientRect を持つ偽物を渡す。
  const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
  });
  const img = { tagName: 'IMG', getBoundingClientRect: () => rect(12.5, 0, 975, 680) };
  const doc = {
    querySelectorAll: () => [img],
    body: { hasAttribute: (n) => n === 'data-image-page', getBoundingClientRect: () => rect(0, 0, 1000, 680) },
  };
  const win = { visualViewport: { width: 1000, height: 680 } };
  const out = measureDocument(doc, win);
  assert.deepEqual(out.viewport, { w: 1000, h: 680, centerX: 500, centerY: 340 });
  assert.equal(out.imageOnlyPage, true);
  assert.deepEqual(out.body, { x: 0, y: 0, w: 1000, h: 680 });
  assert.equal(out.images.length, 1);
  const im = out.images[0];
  assert.equal(im.tag, 'img');
  assert.equal(im.gapLeft, 12.5);
  assert.equal(im.gapRight, 12.5);
  assert.equal(im.centerX, 500);
  assert.deepEqual(im.leftBand, { cell: 1, low: 1, high: 0 });
  assert.deepEqual(im.rightBand, { cell: 99, low: 3, high: 6 });
});
test('本文の枠の位置を足すと、窓の座標にそろう', () => {
  // 本文は iframe の中にあるので、その中で測った値は iframe の左上が原点になる。
  // 物差しは窓に敷いてあるので、枠の左上の位置(origin)を足して窓の座標へそろえる。
  const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
  });
  const img = { tagName: 'IMG', getBoundingClientRect: () => rect(0, 0, 100, 100) };
  const doc = {
    querySelectorAll: () => [img],
    body: { hasAttribute: () => false, getBoundingClientRect: () => rect(0, 0, 100, 100) },
  };
  const out = measureDocument(doc, { innerWidth: 100, innerHeight: 100 }, {
    origin: { x: 40, y: 75 },
    viewport: { w: 1100, h: 792 },
  });
  assert.deepEqual(out.viewport, { w: 1100, h: 792, centerX: 550, centerY: 396 });
  assert.equal(out.images[0].x, 40);
  assert.equal(out.images[0].y, 75);
  assert.equal(out.images[0].right, 140);
  assert.equal(out.images[0].gapRight, 960);   // 1100 - 140
  assert.equal(out.images[0].gapBottom, 617);  // 792 - 175
  assert.deepEqual(out.images[0].leftBand, { cell: 4, low: 4, high: 0 });
  assert.deepEqual(out.body, { x: 40, y: 75, w: 100, h: 100 });
});

test('色からパレットの番号を読み戻せる', () => {
  assert.deepEqual(nearestPalette([0x43, 0x63, 0xD8]), { index: 7, distance: 0 });
  assert.deepEqual(nearestPalette([0xE6, 0x19, 0x4B]), { index: 0, distance: 0 });
  // 多少ずれた色でも、いちばん近い番号になる
  assert.equal(nearestPalette([0xE0, 0x20, 0x50]).index, 0);
});

test('物差しの色を読み戻すと、band() の数と一致する', () => {
  // canvas を DOM なしで真似る。上辺の (x, 5) が 1 の位、(x, 15) が 16 の位。
  const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const fakeCanvas = (cssW, dpr) => ({
    width: cssW * dpr,
    style: { width: cssW + 'px' },
    getContext: () => ({
      getImageData(px, py) {
        const x = px / dpr, y = py / dpr;
        const cell = Math.floor(x / CELL);
        const idx = y < CELL ? cell % 16 : Math.floor(cell / 16) % 16;
        return { data: [...hexToRgb(PALETTE[idx]), 230] };
      },
    }),
  });
  const doc = { getElementById: () => fakeCanvas(1100, 2) };
  for (const x of [155, 160, 165, 320, 550, 800, 995, 2559]) {
    const got = readRibbon(doc, { x });
    assert.equal(got.match, true, 'x=' + x + ' 読み=' + got.readCell + ' 期待=' + got.containCell);
    assert.equal(got.readCell, Math.floor(x / CELL));
  }
  // マスの境目では、読んだ値と band() の四捨五入が 1 つ違う。どちらも正しい。
  const edge = readRibbon(doc, { x: 155 });
  assert.equal(edge.readCell, 15);
  assert.equal(edge.roundedCell, 16);
});

test('左上の 20x20 は、もう一方のリボンに隠れているので読めないと返す', () => {
  const doc = { getElementById: () => ({ width: 100, style: { width: '50px' }, getContext: () => ({ getImageData: () => ({ data: [0, 0, 0, 255] }) }) }) };
  for (const at of [0, 5, 19]) {
    assert.equal(readRibbon(doc, { x: at }).covered, true, 'x=' + at);
    assert.equal(readRibbon(doc, { y: at }).covered, true, 'y=' + at);
    assert.equal(readRibbon(doc, { x: at }).match, null);
  }
});

test('物差しが出ていなければ読めないと返す', () => {
  assert.deepEqual(readRibbon({ getElementById: () => null }, { x: 0 }), { error: 'no overlay' });
});

test('枠が縮めてあれば、倍率を掛けてから位置を足す', () => {
  // 固定レイアウトの本では、600x800 の面を 0.9159 倍に縮めて窓へ収めている。
  const rect = (left, top, width, height) => ({
    left, top, width, height, right: left + width, bottom: top + height,
  });
  const img = { tagName: 'IMG', getBoundingClientRect: () => rect(0, 0, 600, 800) };
  const doc = {
    querySelectorAll: () => [img],
    body: { hasAttribute: () => false, getBoundingClientRect: () => rect(0, 0, 600, 800) },
  };
  const out = measureDocument(doc, { innerWidth: 600, innerHeight: 800 }, {
    origin: { x: 1, y: 29.7 },
    scale: { x: 0.9159, y: 0.9159 },
    viewport: { w: 1100, h: 792 },
  });
  assert.equal(out.images[0].w, 549.5);
  assert.equal(out.images[0].h, 732.7);
  assert.equal(out.images[0].right, 550.5);
  assert.deepEqual(out.images[0].rightBand, { cell: 55, low: 7, high: 3 });
});

test('絵の印が無ければ imageOnlyPage は false', () => {
  const doc = {
    querySelectorAll: () => [],
    body: { hasAttribute: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }) },
  };
  const out = measureDocument(doc, { innerWidth: 10, innerHeight: 10 });
  assert.equal(out.imageOnlyPage, false);
  assert.deepEqual(out.images, []);
});


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

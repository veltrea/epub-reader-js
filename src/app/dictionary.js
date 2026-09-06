// 読み上げ辞書(レイヤー付き前処理)。純粋・DOM 非依存。
// 移植元(Swift 版プロトタイプ)の仕様書 §10.2 に対応。
//
// なぜ音声エンジンのユーザー辞書を使わないか:
//   エンジンの辞書は形態素解析のコストで語を選ぶため、**短い登録語が長い熟語を食い荒らす**。
//   「斎」1文字の読みを登録すると「斎藤」まで巻き添えで読み替わる。優先度を指定しても、
//   それは解析コストの調整であって「置換する順番」ではないので、この事故は原理的に防げない。
//
// 解法: アプリ側でレイヤー順に置換し、**一度置換した領域は以降のレイヤーで触らない**。
//   置換結果は読み上げにだけ効き、画面表示は変わらない。

import { hiraganaToKatakana } from './kana.js';

/** 挿入した語境界を表す私用領域文字。原文由来の空白と区別するために使う。 */
export const BOUNDARY = '';

/** ポーズを生む区切り文字。VOICEVOX 0.25.1 で実測した癖に合わせている。 */
const DELIMS = '、。，．！？…‥―—　 ' + BOUNDARY;
/** ポーズも生まず、読む文字でもない字。 */
const IGNORE = '\n\r\t';

export const LAYER_MIN = 1;
export const LAYER_MAX = 10;
export const KINDS = ['word', 'pattern'];

/**
 * 「この場所だけ」の登録で、指定された位置からどれだけ離れていても当てはめるか(文字数)。
 *
 * 位置は外から与えられることを想定している(校正の一覧など)。**文字の数え方は道具ごとに
 * 違う**——ルビをどう数えるか、改行を数えるか、記号を含めるか。そのまま信じると 1 文字
 * ずれた場所を読み替えてしまう。そこで位置は「目印」として使い、実際にどこを読み替えるかは
 * **表記が一致すること**で決める。この幅は「目印の周りをどこまで探すか」である。
 */
export const AT_WINDOW = 40;

/**
 * 前後の文字に付けられる条件。**正規表現を書かずに「直前がひらがなのときだけ」を指定できる**
 * ようにするためのもの。中身は後読み `(?<=…)` と先読み `(?=…)` に組み立てる。
 *
 * 一文字の漢字を登録すると熟語まで読み替えてしまう（「行」を登録すると「銀行」「旅行」まで
 * 変わる）。それを防ぐのがこの条件である。「直前が漢字以外のときだけ」にすれば、
 * 熟語の中の字には当たらない。
 *
 * 値は before / after の両方で使う。`any` は「条件なし」で、項目には持たせない。
 */
export const CONTEXTS = ['any', 'kana', 'kata', 'kanji', 'notKanji', 'digit'];

/** 条件ごとの文字の範囲。before と after で同じものを使う。 */
const CONTEXT_CLASS = {
  kana: '[ぁ-ん]',
  kata: '[ァ-ヴー]',
  kanji: '[一-龥々]',
  notKanji: '[一-龥々]',   // 打ち消して使う(下の contextRe を見る)
  digit: '[0-9０-９]',
};

/**
 * 条件を、正規表現の前後に足す文字列にする。
 * @param {string} kind  CONTEXTS のどれか
 * @param {boolean} isBefore  直前の条件なら true、直後なら false
 */
function contextRe(kind, isBefore) {
  const cls = CONTEXT_CLASS[kind];
  if (!cls) return '';
  const negate = kind === 'notKanji';
  if (isBefore) return negate ? `(?<!${cls})` : `(?<=${cls})`;
  return negate ? `(?!${cls})` : `(?=${cls})`;
}

/** 前後の条件を正規化する。知らない値と 'any' は「条件なし」として null にする。 */
export function normalizeContext(v) {
  return CONTEXTS.includes(v) && v !== 'any' ? v : null;
}

const clampLayer = (n) => Math.min(LAYER_MAX, Math.max(LAYER_MIN, Math.trunc(n)));

/**
 * 「この場所だけ」の位置を正規化する。壊れていれば null(＝場所の指定なし)。
 * section は章の番号、offset はその章の先頭から数えた文字数。
 */
export function normalizeAt(at) {
  if (!at || typeof at !== 'object') return null;
  const section = Math.trunc(Number(at.section));
  const offset = Math.trunc(Number(at.offset));
  if (!Number.isFinite(section) || section < 0) return null;
  if (!Number.isFinite(offset) || offset < 0) return null;
  const w = Math.trunc(Number(at.window));
  return { section, offset, window: Number.isFinite(w) && w >= 0 ? w : AT_WINDOW };
}

/**
 * 1件を正規化する。旧形式({yomi, priority, accentType})からの移行もここで行う。
 * @returns {?{surface:string, reading:string, layer:number, kind:string, padsBoundary:boolean, enabled:boolean, at:?object}}
 */
export function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const surface = String(e.surface ?? '').trim();
  // reading が正。旧データは yomi に入っている。
  const reading = String(e.reading ?? e.yomi ?? '').trim();
  if (!surface || !reading) return null;
  // 旧 priority(0..10) はそのままレイヤーの意味に読み替える(大きいほど先に適用)。
  const rawLayer = Number.isFinite(e.layer) ? e.layer
    : Number.isFinite(e.priority) ? e.priority : 5;
  const kind = KINDS.includes(e.kind) ? e.kind : 'word';
  const out = {
    surface,
    reading,
    layer: clampLayer(rawLayer),
    kind,
    padsBoundary: e.padsBoundary === true,
    enabled: e.enabled !== false,
  };
  // 場所の指定は、あるときだけ持たせる(無い登録の形を変えない)。
  const at = normalizeAt(e.at);
  if (at) out.at = at;
  // 前後の条件も、あるときだけ持たせる。
  const before = normalizeContext(e.before);
  if (before) out.before = before;
  const after = normalizeContext(e.after);
  if (after) out.after = after;
  return out;
}

/**
 * 配列を正規化 + 適用順に並べる。
 * 並び順 = レイヤー降順 → 同レイヤーは surface の文字数の降順(長い語を先に食わせる)。
 * 同一 surface の重複は後勝ちで畳む。
 */
export function normalizeList(list) {
  const map = new Map();
  for (const raw of list || []) {
    const e = normalizeEntry(raw);
    // 場所の指定があるものは、**同じ表記でも場所ごとに別の登録**として残す。
    // 「1234 文字目の『行った』」と「5678 文字目の『行った』」は別物である。
    // 前後の条件が違えば別の規則なので、これも見分けの一部にする。
    // 「直前がひらがなの『行』」と「直前が漢字以外の『行』」は別物である。
    if (e) {
      map.set([e.kind, e.surface, e.at ? `${e.at.section}:${e.at.offset}` : '',
        e.before || '', e.after || ''].join('\u0000'), e);
    }
  }
  return [...map.values()].sort((a, b) => b.layer - a.layer
    // 同じレイヤーなら、場所を決めてある登録を先に当てる(狭く決めた指定を優先する)。
    || (b.at ? 1 : 0) - (a.at ? 1 : 0)
    || b.surface.length - a.surface.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeTemplate = (s) => s.replace(/\$/g, '$$$$'); // $ を捕捉参照と誤解させない

/**
 * パターンの読みの中の `$1`..`$9` / `$&` を、実際に捕捉した文字列で置き換える。
 *
 * **捕捉した部分はカタカナに直す。** 読みはカタカナで揃える約束なので、ひらがなのまま
 * 混ざると読み方がエンジン任せになる。素の String.replace に任せると、テンプレートの
 * 側だけがカタカナ化され、`$1` に入る中身は元のひらがなのまま残ってしまう。
 *
 * **exec の結果をそのまま使う。** 一致した文字列を取り出してもう一度当て直す作りにすると、
 * 後読み `(?<=…)` と先読み `(?=…)` が必ず外れる。それらは幅を持たないので一致した文字列に
 * 入らず、切り出した断片には前後の文字が無いためである。
 *
 * これで次のどちらの書き方もできる。
 *   捕まえて書き戻す: 表記 `([ぁ-ん]+)行った` / 読み `$1オコナッタ`
 *   条件にするだけ  : 表記 `(?<=[ぁ-ん])行った` / 読み `オコナッタ`
 *
 * @param {string} template  カタカナ化済みの読み(ただし $n はそのまま残っている)
 * @param {Array} m          正規表現の exec が返した一致(m[0]=全体, m[1..]=捕捉)
 */
function expandTemplate(template, m) {
  return template.replace(/\$\$|\$&|\$(\d)/g, (tok, n) => {
    if (tok === '$$') return '$';
    if (tok === '$&') return hiraganaToKatakana(String(m[0] ?? ''));
    return hiraganaToKatakana(String(m[+n] ?? ''));
  });
}

/**
 * 適用可能な形へコンパイルする。壊れた正規表現のエントリは黙って除外する
 * (適用時に落ちないことを優先。UI 側で別途「不正なパターン」を警告する)。
 */
export function compile(list) {
  const out = [];
  for (const e of normalizeList(list)) {
    if (!e.enabled) continue;
    try {
      // パターンは丸ごと囲む。囲まないと `あ|い` のような選択のとき、前後の条件が
      // 片方にしか掛からない((?<=x)あ|い が ((?<=x)あ)|い になる)。
      // 非捕捉の丸括弧なので $1 の番号はずれない。
      const body = e.kind === 'pattern' ? `(?:${e.surface})` : escapeRe(e.surface);
      const withCtx = contextRe(e.before, true) + body + contextRe(e.after, false);
      const re = new RegExp(withCtx, 'g');
      const template = e.kind === 'pattern'
        ? hiraganaToKatakana(e.reading)
        : escapeTemplate(hiraganaToKatakana(e.reading));
      // reOne は「一致した部分だけを $1 参照込みで置換する」ための非 global 版。
      out.push({
        // reOne は「条件を外した本体だけ」。一致した文字列にもう一度当てるのに使うので、
        // 幅を持たない条件が入っていると必ず外れる。
        re, reOne: new RegExp(body), template,
        isPattern: e.kind === 'pattern',
        at: e.at || null,
        padsBoundary: e.padsBoundary, source: e,
      });
    } catch { /* コンパイル不能は除外 */ }
  }
  return out;
}

/** 正規表現として妥当か(UI の警告用)。 */
export function isValidPattern(src) {
  try { new RegExp(src); return true; } catch { return false; }
}

/**
 * 「この場所だけ」の登録について、**その文の中で読み替える一致を 1 つだけ選ぶ**。
 *
 * 位置は目印にすぎない。当てはめる場所は表記の一致で決め、位置は「どの一致か」を
 * 選ぶのに使う。与えられた位置が多少ずれていても、その周り(at.window の幅)に同じ表記が
 * あればそこを読み替える。
 *
 * **窓の中の一致を全部ではなく、指定位置にいちばん近い 1 つだけを選ぶ。**
 * 同じ語が近くに 2 回出てくる文はいくらでもある（「会議を行った。彼は学校へ行った。」）。
 * 窓に入ったもの全部を読み替えると、指定していない方まで巻き込む。
 *
 * @returns {?{segIndex:number, index:number}} 選んだ一致。窓の中に無ければ null。
 */
function pickNearest(segments, entry, where, lead) {
  if (!where) return null;                // どこを読んでいるか分からないときは当てない
  if (where.section != null && entry.at.section !== where.section) return null;
  let best = null;
  segments.forEach((seg, si) => {
    if (seg.locked || !seg.text) return;
    entry.re.lastIndex = 0;
    let m;
    while ((m = entry.re.exec(seg.text)) !== null) {
      if (m[0] === '') { entry.re.lastIndex++; continue; }
      const here = (where.offset || 0) + lead + seg.start + m.index;
      const d = Math.abs(here - entry.at.offset);
      if (d <= entry.at.window && (best === null || d < best.d)) best = { segIndex: si, index: m.index, d };
    }
  });
  return best;
}

/**
 * 読み辞書を適用して合成用のテキストを作る。
 * 一度置換した断片は locked にして以降のレイヤーで触らない。
 *
 * @param {string} raw    読み上げる文
 * @param {Array} list    辞書(生の配列でも compile 済みでもよい)
 * @param {?object} where この文が本のどこにあるか { section, offset }。
 *                        章の番号と、その章の先頭から数えた文字数。
 *                        渡さないと「この場所だけ」の登録は当てない(当てる場所を
 *                        決められないため。黙って別の場所を読み替えるより安全)。
 * @returns {{text:string, gapCount:number, silenceGaps:number[], changed:boolean}}
 *   silenceGaps は「挿入した境界だけを無音化する」ための区切りの序数(10.2 参照)。
 */
export function prepare(raw, list, where = null) {
  const compiled = Array.isArray(list) && list.length && list[0]?.re ? list : compile(list);
  const src = String(raw ?? '');
  // trim で落ちた先頭のぶんだけ、文の中の位置がずれる。位置合わせに足し戻す。
  const lead = src.length - src.trimStart().length;
  let segments = [{ text: src.trim(), start: 0, locked: false }];
  let changed = false;

  for (const entry of compiled) {
    // 場所を決めた登録は、どこを読んでいるか分からないときは当てない。
    if (entry.at && !where) continue;
    // 場所を決めた登録は、先に「読み替える一致」を 1 つだけ決めておく。
    let target = null;
    if (entry.at) {
      target = pickNearest(segments, entry, where, lead);
      if (!target) continue;              // 指定の近くにその表記が無い
    }
    const next = [];
    for (const [segIndex, seg] of segments.entries()) {
      if (seg.locked || !seg.text) { next.push(seg); continue; }
      entry.re.lastIndex = 0;
      let last = 0;
      let m;
      let hit = false;
      while ((m = entry.re.exec(seg.text)) !== null) {
        if (m[0] === '') { entry.re.lastIndex++; continue; } // 空一致で無限ループしない
        // 場所を決めた登録は、選んでおいた 1 つの一致だけを読み替える。
        // それ以外は飛ばす(last を動かさないので、その部分は元のまま残る)。
        if (entry.at && !(segIndex === target.segIndex && m.index === target.index)) continue;
        hit = true;
        if (m.index > last) next.push({ text: seg.text.slice(last, m.index), start: seg.start + last, locked: false });
        // パターンのときは $n を自分で展開する(捕捉した部分もカタカナに直すため、
        // また後読み・先読みを外さないため)。
        let rep = entry.isPattern
          ? expandTemplate(entry.template, m)
          : m[0].replace(entry.reOne, entry.template);
        if (entry.padsBoundary) rep = BOUNDARY + rep + BOUNDARY;
        next.push({ text: rep, start: seg.start + m.index, locked: true });
        last = m.index + m[0].length;
      }
      if (!hit) { next.push(seg); continue; }
      changed = true;
      if (last < seg.text.length) next.push({ text: seg.text.slice(last), start: seg.start + last, locked: false });
    }
    segments = next;
  }

  const joined = segments.map((s) => s.text).join('');
  const runs = gapRuns(joined);
  const silenceGaps = [];
  runs.forEach((run, i) => {
    // 境界マーカーを含み、かつ全体が空白類だけの run のみ無音化する。
    // 読点などが隣接していたら、そちらのポーズを尊重して触らない。
    if (run.includes(BOUNDARY) && /^[\s　]+$/.test(run)) silenceGaps.push(i);
  });
  // マーカーも空白として数えていたので、半角空白へ置換しても区切りの並びは変わらない。
  const text = joined.split(BOUNDARY).join(' ');
  return { text, gapCount: runs.length, silenceGaps, changed };
}

/**
 * ポーズを生む区切りの run を先頭から順に列挙する。
 * - 区切り文字の連続は 1 つの run にまとめる(連続した区切りは 1 つのポーズに潰れる)
 * - その run より前と後の**両方**に読み上げられる字があるときだけ採用する
 *   (文頭・文末の句点はポーズを生まない)
 */
export function gapRuns(text) {
  const chars = [...String(text ?? '')].filter((c) => !IGNORE.includes(c));
  const isDelim = (c) => DELIMS.includes(c);
  const runs = [];
  let i = 0;
  while (i < chars.length) {
    if (!isDelim(chars[i])) { i++; continue; }
    const start = i;
    while (i < chars.length && isDelim(chars[i])) i++;
    const before = chars.slice(0, start).some((c) => !isDelim(c));
    const after = chars.slice(i).some((c) => !isDelim(c));
    if (before && after) runs.push(chars.slice(start, i).join(''));
  }
  return runs;
}

/**
 * 同じ表記の登録が既にあるかどうかを探す。**画面を作らないので、単体で試せる。**
 *
 * 使いどころ: 本文で語を選んで「登録」を押したとき、その語を前に登録していたら、
 * 新しく空の 1 件を作らずに**前に入れた読みが入った状態**で開く。新しく作ると同じ表記が
 * 二重に並び、どちらが効いているのか分からなくなる。
 *
 * 探す順は読み上げと同じ「この本だけ → すべての本」。読み上げでは同じ表記なら
 * 「この本だけ」の登録が使われるので、直す相手もそちらでなければならない。
 *
 * パターン(正規表現)の登録は相手にしない。表記が正規表現なので、本文から選んだ
 * 文字列と文字どおり同じになることは無い。
 *
 * @param {{common:Array, book:?Array}} lists  2 つの辞書。book は無ければ null
 * @param {string} surface  本文から選んだ表記
 * @param {?object} place   「この場所だけ」で登録するときの位置 { section, offset }。
 *                          決めていなければ null
 * @returns {?{scope:string, index:number}} 見つかった登録の場所。無ければ null
 */
export function findEntry(lists, surface, place = null) {
  const want = String(surface ?? '').trim();
  if (!want) return null;
  for (const scope of ['book', 'common']) {
    const list = lists?.[scope];
    if (!Array.isArray(list)) continue;
    const rows = list
      .map((e, index) => ({ e, index }))
      .filter(({ e }) => (e.kind || 'word') === 'word' && e.surface === want);
    if (place) {
      // 場所を決めた登録どうしを見比べる。同じ章にあって、その登録が探す範囲に
      // 収まっているものを、指定した位置に近い順に選ぶ。
      const near = rows
        .filter(({ e }) => e.at && e.at.section === place.section)
        .map((r) => ({ ...r, d: Math.abs(r.e.at.offset - place.offset) }))
        .filter((r) => r.d <= (Number.isFinite(r.e.at.window) ? r.e.at.window : AT_WINDOW))
        .sort((a, b) => a.d - b.d);
      if (near.length) return { scope, index: near[0].index };
      continue;
    }
    // 場所を決めていない登録だけを相手にする。前後の条件が付いたものは
    // 「その場面だけの規則」なので、条件の無いものを先に選ぶ。
    const plain = rows.filter(({ e }) => !e.at);
    const hit = plain.find(({ e }) => !e.before && !e.after) || plain[0];
    if (hit) return { scope, index: hit.index };
  }
  return null;
}

/** 一覧表示用: レイヤー降順のセクションへ分ける(= 実際に適用される順)。 */
export function groupByLayer(list) {
  const groups = new Map();
  for (const e of normalizeList(list)) {
    if (!groups.has(e.layer)) groups.set(e.layer, []);
    groups.get(e.layer).push(e);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]);
}

/**
 * 旧 UI 互換の薄いラッパー(テキストだけ欲しい場合)。
 * 境界マーカーは半角空白へ落とす。
 */
export function applyReadings(text, list) {
  return prepare(text, list).text;
}

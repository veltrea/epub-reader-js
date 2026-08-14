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

const clampLayer = (n) => Math.min(LAYER_MAX, Math.max(LAYER_MIN, Math.trunc(n)));

/**
 * 1件を正規化する。旧形式({yomi, priority, accentType})からの移行もここで行う。
 * @returns {?{surface:string, reading:string, layer:number, kind:string, padsBoundary:boolean, enabled:boolean}}
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
  return {
    surface,
    reading,
    layer: clampLayer(rawLayer),
    kind,
    padsBoundary: e.padsBoundary === true,
    enabled: e.enabled !== false,
  };
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
    if (e) map.set(e.kind + '\u0000' + e.surface, e);
  }
  return [...map.values()].sort((a, b) => b.layer - a.layer || b.surface.length - a.surface.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeTemplate = (s) => s.replace(/\$/g, '$$$$'); // $ を捕捉参照と誤解させない

/**
 * 適用可能な形へコンパイルする。壊れた正規表現のエントリは黙って除外する
 * (適用時に落ちないことを優先。UI 側で別途「不正なパターン」を警告する)。
 */
export function compile(list) {
  const out = [];
  for (const e of normalizeList(list)) {
    if (!e.enabled) continue;
    try {
      const re = e.kind === 'pattern'
        ? new RegExp(e.surface, 'g')
        : new RegExp(escapeRe(e.surface), 'g');
      const template = e.kind === 'pattern'
        ? hiraganaToKatakana(e.reading)
        : escapeTemplate(hiraganaToKatakana(e.reading));
      // reOne は「一致した部分だけを $1 参照込みで置換する」ための非 global 版。
      out.push({ re, reOne: new RegExp(re.source), template, padsBoundary: e.padsBoundary, source: e });
    } catch { /* コンパイル不能は除外 */ }
  }
  return out;
}

/** 正規表現として妥当か(UI の警告用)。 */
export function isValidPattern(src) {
  try { new RegExp(src); return true; } catch { return false; }
}

/**
 * 読み辞書を適用して合成用のテキストを作る。
 * 一度置換した断片は locked にして以降のレイヤーで触らない。
 * @returns {{text:string, gapCount:number, silenceGaps:number[], changed:boolean}}
 *   silenceGaps は「挿入した境界だけを無音化する」ための区切りの序数(10.2 参照)。
 */
export function prepare(raw, list) {
  const compiled = Array.isArray(list) && list.length && list[0]?.re ? list : compile(list);
  let segments = [{ text: String(raw ?? '').trim(), locked: false }];
  let changed = false;

  for (const entry of compiled) {
    const next = [];
    for (const seg of segments) {
      if (seg.locked || !seg.text) { next.push(seg); continue; }
      entry.re.lastIndex = 0;
      let last = 0;
      let m;
      let hit = false;
      while ((m = entry.re.exec(seg.text)) !== null) {
        if (m[0] === '') { entry.re.lastIndex++; continue; } // 空一致で無限ループしない
        hit = true;
        if (m.index > last) next.push({ text: seg.text.slice(last, m.index), locked: false });
        let rep = m[0].replace(entry.reOne, entry.template);
        if (entry.padsBoundary) rep = BOUNDARY + rep + BOUNDARY;
        next.push({ text: rep, locked: true });
        last = m.index + m[0].length;
      }
      if (!hit) { next.push(seg); continue; }
      changed = true;
      if (last < seg.text.length) next.push({ text: seg.text.slice(last), locked: false });
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

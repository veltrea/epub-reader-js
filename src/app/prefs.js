// 「全体既定」と「本ごとの上書き」の関係。
// 移植元(Swift 版プロトタイプ)の仕様書 §3.5 / §15.3 に対応。
//
//   値の解決: 本ごとの指定があればそれ、無ければ全体既定
//   値の記憶: 設定しようとした値が全体既定と同じなら、本ごとの指定は**持たない**
//             (あとで既定を変えたときに追従させるため)
//   例外   : 強制アスペクト比は本ごとにしか持たない(正解が本によって違うため)

import { storeGet, storeSet } from './api.js';

/** 全体既定にフォールバックする項目。 */
export const SHARED_KEYS = ['writingMode', 'binding', 'imageSpread', 'textSpread', 'renderMode'];
/** 本ごとにしか持たない項目。 */
export const BOOK_ONLY_KEYS = ['aspect', 'spreadShift', 'css'];

export const SPREAD_MODES = ['auto', 'always', 'never'];
export const RENDER_MODES = ['friendly', 'raw'];

/** 見開き/表示モードの巡回。 */
export function nextSpread(cur) {
  const i = SPREAD_MODES.indexOf(cur || 'auto');
  return SPREAD_MODES[(i + 1) % SPREAD_MODES.length];
}
export function nextRenderMode(cur) {
  return cur === 'raw' ? 'friendly' : 'raw';
}

/** 実際に使う値。 */
export function resolvePref(bookPrefs, globals, key) {
  const v = bookPrefs?.[key];
  if (v !== undefined && v !== null && v !== '') return v;
  return globals?.[key];
}

/**
 * 本ごとの上書きを更新した新しい prefs を返す(元は変更しない)。
 * 全体既定と同じ値なら上書きを消す。
 */
export function setPref(bookPrefs, globals, key, value) {
  const next = { ...(bookPrefs || {}) };
  if (!BOOK_ONLY_KEYS.includes(key) && globals?.[key] === value) delete next[key];
  else if (value === undefined || value === null || value === '') delete next[key];
  else next[key] = value;
  return next;
}

// ---------------------------------------------------------------------------
// 永続化
// ---------------------------------------------------------------------------

const keyOf = (bookId) => 'prefs-' + String(bookId || '').replace(/[^a-zA-Z0-9_-]/g, '');

/**
 * 本ごとの上書きを読む。全体既定と同値になった項目は捨てる(自己修復)。
 * 残したままだと「あとで既定を変えたのに、この本だけ追従しない」が起きる。
 */
export async function loadBookPrefs(bookId, globals) {
  const raw = (await storeGet(keyOf(bookId))) || {};
  if (!globals) return raw;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!BOOK_ONLY_KEYS.includes(k) && globals[k] === v) continue;
    out[k] = v;
  }
  return out;
}
export async function saveBookPrefs(bookId, prefs) {
  await storeSet(keyOf(bookId), prefs || {});
}

// ---------------------------------------------------------------------------
// アスペクト比(§3.5)
// ---------------------------------------------------------------------------

/** "844:1200" / "3:4" / "1.5" を {width, height} へ。不正なら null。 */
export function parseAspect(s) {
  const str = String(s ?? '').trim();
  if (!str) return null;
  const m = str.split(':');
  const w = parseFloat(m[0]);
  const h = m.length > 1 ? parseFloat(m[1]) : 1;
  if (!(w > 0) || !(h > 0)) return null;
  return { width: w, height: h };
}
/** {width, height} → "844:1200"。 */
export function aspectToString(a) {
  if (!a || !(a.width > 0) || !(a.height > 0)) return '';
  return `${Math.round(a.width)}:${Math.round(a.height)}`;
}
/** 表示用ラベル "844 : 1200"。 */
export function aspectLabel(a) {
  const s = aspectToString(a);
  return s ? s.replace(':', ' : ') : '';
}
/** メニューに出すプリセット(文庫・漫画単行本・A判・B5・正方形)。 */
export const ASPECT_PRESETS = ['2:3', '3:4', '210:297', '182:257', '1:1'];

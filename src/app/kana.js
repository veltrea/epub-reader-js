// かな関連の純粋関数。DOM 非依存・Node/Deno でそのまま動く(テスト容易性のため分離)。

/** ひらがな→カタカナ。VOICEVOX はカタカナ読みを要求する。 */
export function hiraganaToKatakana(s) {
  let out = '';
  for (const ch of s) {
    const u = ch.codePointAt(0);
    if (u >= 0x3041 && u <= 0x3096) out += String.fromCodePoint(u + 0x60);
    else out += ch;
  }
  return out;
}

/** カタカナ→ひらがな。 */
export function katakanaToHiragana(s) {
  let out = '';
  for (const ch of s) {
    const u = ch.codePointAt(0);
    if (u >= 0x30a1 && u <= 0x30f6) out += String.fromCodePoint(u - 0x60);
    else out += ch;
  }
  return out;
}

// 五十音の行(見出し)。書棚の分類に使う。
const GOJUON = [
  ['あ', 'あいうえお'],
  ['か', 'かきくけこがぎぐげご'],
  ['さ', 'さしすせそざじずぜぞ'],
  ['た', 'たちつてとだぢづでど'],
  ['な', 'なにぬねの'],
  ['は', 'はひふへほばびぶべぼぱぴぷぺぽ'],
  ['ま', 'まみむめも'],
  ['や', 'やゆよ'],
  ['ら', 'らりるれろ'],
  ['わ', 'わをん'],
];

/**
 * 作者の読み(かな)からセクション見出しを返す(Swift版 ShelfView.sectionKey 移植)。
 * かな→行頭字(あ〜わ) / ASCII英字→大文字1字(A〜Z) / 数字→# / 漢字など読み無し→他 / 空→—。
 */
export function gojuonSection(reading, title) {
  const key = ((reading && reading.trim()) || '');
  const src = key || ((title && title.trim()) || '');
  if (!src) return '—';                                  // 作者(読み)なし
  let head = katakanaToHiragana(src[Symbol.iterator]().next().value || '');
  const small = { 'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お', 'っ': 'つ', 'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'ゎ': 'わ' };
  head = small[head] || head;
  for (const [label, set] of GOJUON) {
    if (set.includes(head)) return label;
  }
  const code = head.codePointAt(0);
  if (head >= '0' && head <= '9') return '#';            // 数字
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return head.toUpperCase(); // ASCII英字
  return '他';                                           // 漢字など(読み未取得)
}

/** セクション見出しの並び順: あ〜わ → A〜Z → # → 他 → —(作者なし)。 */
export const GOJUON_ORDER = [
  ...['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ'],
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
  '#', '他', '—',
];

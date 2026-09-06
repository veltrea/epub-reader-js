// 実在の EPUB を「無難に表示する」ための補正群。
// 移植元(Swift 版プロトタイプ)の仕様書 §8.3 / §8.4 / §8.11 / §8.12 に対応。
//
// friendly モード(既定)でだけ効かせ、raw モードでは元に戻す。
// raw は「EPUB の指定どおりに描いた姿」を見るための検版モードで、
// 配色・文字サイズ・行間・ユーザー CSS(=読書設定)は raw でも効く。

// ---------------------------------------------------------------------------
// §8.3 書字方向の CSS(純粋・文字列を組み立てるだけ)
// ---------------------------------------------------------------------------

// EBPAJ 制作ガイドの組み方向クラス。日本の商業 EPUB は html 要素にこのクラスを付け、
// writing-mode 自体は本の CSS で当てる約束になっている。変換を経た本では
// クラスだけ残って定義が落ちていることがあるので、既定値をこちらで補う。
// 詳細度を低く保つため body には当てない(継承で body へ届く。body に直接当てると
// 本が body に書いた指定を踏み潰してしまう)。
export function ebpajClassCSS() {
  const wm = (v) => `writing-mode:${v};-webkit-writing-mode:${v};-epub-writing-mode:${v};`;
  return `html.vrtl{${wm('vertical-rl')}}
html.vltr{${wm('vertical-lr')}}
html.hltr{${wm('horizontal-tb')}}
html.hrtl{${wm('horizontal-tb')}}`;
}

// OPF の <meta name="primary-writing-mode"> 由来の補い。
// **EBPAJ クラスを持たない文書にだけ**効かせる。縦書き本でも前付け・奥付は
// 横組み(hltr)のことがあり、本全体を縦書きにすると壊れるため。
export function opfHintCSS(hint) {
  const v = normalizeWritingHint(hint);
  if (!v) return '';
  const not = 'html:not(.vrtl):not(.vltr):not(.hltr):not(.hrtl)';
  const wm = `writing-mode:${v};-webkit-writing-mode:${v};-epub-writing-mode:${v};`;
  return `${not}, ${not} > body{${wm}}`;
}

// 強制モード(auto 以外)。本の指定に必ず勝たせるので !important + post 側へ置く。
// ブロック要素は「親から継承」にして向きを一本化する。span 等は触らないので
// 縦中横(text-combine-upright)やルビの見た目は保たれる。
export function forcedWritingCSS(mode) {
  const v = mode === 'vertical' ? 'vertical-rl' : mode === 'horizontal' ? 'horizontal-tb' : null;
  if (!v) return '';
  return `html, body { writing-mode: ${v} !important; -webkit-writing-mode: ${v} !important; }
    body div, body section, body article, body main, body header, body footer,
    body p, body blockquote, body li, body td, body th, body figure {
      writing-mode: inherit !important; -webkit-writing-mode: inherit !important;
    }`;
}

/** primary-writing-mode の値を CSS の writing-mode 値へ正規化(未知なら null)。 */
export function normalizeWritingHint(hint) {
  const s = String(hint || '').trim().toLowerCase();
  if (s === 'vertical-rl' || s === 'vertical-lr' || s === 'horizontal-tb') return s;
  if (s.startsWith('vertical')) return 'vertical-rl';
  if (s.startsWith('horizontal')) return 'horizontal-tb';
  return null;
}

// ---------------------------------------------------------------------------
// §8.4 綴じ方向の補助判定(章の文書を見る)
// ---------------------------------------------------------------------------

/** 実際に組まれた向きが縦書きか。documentElement ではなく **body** を見る。 */
export function isVerticalDoc(doc) {
  try {
    const cs = doc.defaultView.getComputedStyle(doc.body);
    return cs.writingMode.startsWith('vertical');
  } catch { return false; }
}

/** 章の見かけの進行方向。**page-progression-direction は見ない**(残骸のことがある)。 */
export function pageDirection(doc) {
  if (isVerticalDoc(doc)) return 'rtl';
  try {
    const cs = doc.defaultView.getComputedStyle(doc.body);
    if (cs.direction === 'rtl') return 'rtl';
  } catch { /* noop */ }
  if (doc.body?.dir === 'rtl' || doc.documentElement?.dir === 'rtl') return 'rtl';
  return 'ltr';
}

const MATTER_RE = /\b(cover|toc|landmarks|frontmatter|backmatter|titlepage|halftitlepage|colophon|copyright-page|imprint|dedication|acknowledgments|bibliography|index)\b/;

/** 表紙・前付け・奥付か。横組みで作られていることが多く、向きの証拠にできない。 */
export function isFrontOrBackMatter(doc) {
  const body = doc?.body;
  if (!body) return false;
  const cands = [
    doc.documentElement, body, body.firstElementChild,
    body.querySelector('section, div'),
  ];
  for (const el of cands) {
    if (!el?.getAttribute) continue;
    const vals = [
      el.getAttribute('epub:type'),
      el.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type'),
      el.getAttribute('role'),
    ];
    for (const v of vals) if (v && MATTER_RE.test(String(v).toLowerCase())) return true;
  }
  return false;
}

/** 向きの証拠になる本文を持つか。絵だけの面は原理的に向きを測れないので false。 */
export function hasDirectionEvidence(doc) {
  if (String(doc?.contentType || '').startsWith('image/')) return false;
  const text = (doc?.body?.textContent || '').replace(/[\s　]/g, '');
  return text.length > 10;
}

/** 画像だけの面か(本文がほぼ無く、絵がある)。 */
export function detectImagePage(doc) {
  const body = doc?.body;
  if (!body) return false;
  if (!body.querySelector('img, svg, image')) return false;
  return (body.textContent || '').replace(/[\s　]/g, '').length <= 10;
}

// ---------------------------------------------------------------------------
// §8.11 SVG 表紙の潰れ補正
// ---------------------------------------------------------------------------
// calibre 変換 EPUB の表紙は
//   <svg width="100%" height="100%" preserveAspectRatio="none"><image .../></svg>
// が定番。none は「比率を無視して伸ばせ」なので表紙が縦に潰れる。
// preserveAspectRatio は CSS プロパティではなく、object-fit も SVG 要素には効かないので
// **DOM の属性を書き換えるしかない**。元の値は data-* に退避し raw で戻す。

const PAR_STASH = 'data-orig-par';

export function normalizeSVGImages(doc) {
  let n = 0;
  for (const el of doc.querySelectorAll('svg[preserveAspectRatio], image[preserveAspectRatio]')) {
    const cur = el.getAttribute('preserveAspectRatio') || '';
    if (!/^none\b/i.test(cur.trim())) continue;      // "none slice" のような meetOrSlice 付きも対象
    if (!el.hasAttribute(PAR_STASH)) el.setAttribute(PAR_STASH, cur);
    el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    n++;
  }
  return n;
}

export function restoreSVGImages(doc) {
  let n = 0;
  for (const el of doc.querySelectorAll(`[${PAR_STASH}]`)) {
    el.setAttribute('preserveAspectRatio', el.getAttribute(PAR_STASH));
    el.removeAttribute(PAR_STASH);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// §8.12 ぶら下げインデントの補正
// ---------------------------------------------------------------------------
// 日本語の本は章見出しを text-indent:-5.2em と padding-top:5.2em の対で組むことが多い。
// 縦書きでは padding-top が行の先頭側なので負のインデントをちょうど打ち消すが、
// 横書きで描くと text-indent は左へ効くのに padding は上のままで打ち消しが外れ、
// 見出しが枠の外へ飛び出す(実本の章扉で 79px はみ出すのを実測)。
// 対になっている物理 padding を見つけ、行の先頭側の padding へ入れ直す。

const HANG_MARK = 'data-hang-fixed';

/** 補正すべき padding 辺を決める純粋関数。対の padding が無ければ null(=本来のぶら下げ組み)。 */
export function hangingFix({ indent, vertical, rtl, padding }) {
  if (!(indent < -4)) return null;                    // 負のインデントでなければ対象外
  const need = -indent;
  const start = vertical ? 'top' : (rtl ? 'right' : 'left');
  const near = (v) => Math.abs(v - need) <= 2;
  if (near(padding[start] || 0)) return null;         // 既に正しい
  const others = ['top', 'right', 'bottom', 'left'].filter((k) => k !== start);
  if (!others.some((k) => near(padding[k] || 0))) return null;  // 対を持たない = 触らない
  return { side: start, value: need };
}

export function fixHangingIndent(doc) {
  const body = doc?.body;
  if (!body || body.hasAttribute(HANG_MARK)) return 0;
  body.setAttribute(HANG_MARK, '');
  const win = doc.defaultView;
  const vertical = isVerticalDoc(doc);
  let n = 0;
  for (const el of body.querySelectorAll('*')) {
    let cs;
    try { cs = win.getComputedStyle(el); } catch { continue; }
    const fix = hangingFix({
      indent: parseFloat(cs.textIndent) || 0,
      vertical,
      rtl: cs.direction === 'rtl',
      padding: {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
      },
    });
    if (!fix) continue;
    el.style.setProperty(`padding-${fix.side}`, `${fix.value}px`, 'important');
    n++;
  }
  return n;
}

/** raw へ切り替えるとき、friendly が付けた印を落として再判定できるようにする。 */
export function clearHangingIndent(doc) {
  doc?.body?.removeAttribute(HANG_MARK);
}

// ---------------------------------------------------------------------------
// §8.13 目次のリンク切れ救済(純粋部分)
// ---------------------------------------------------------------------------
// 変換を経た本では、spine から外れたファイルを目次が指したまま残ることがある
// (calibre が表紙を差し替えると目次の「表紙」だけ古い c0.xhtml を指し続ける等)。
// そのままだとその項目だけ黙って反応しない。

/** href からクエリ・フラグメントを外したファイル名。 */
export function hrefFileName(href) {
  const s = String(href || '').split('#')[0].split('?')[0];
  const i = s.lastIndexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

/**
 * OS のファイルパスから、いちばん後ろの名前だけを取り出す。
 *
 * **上の `hrefFileName` と混ぜないこと。** あちらは EPUB の中の href 用で、
 * EPUB は ZIP なので中の区切りは**必ず `/`** である。`\\` で切ると壊れる。
 * こちらは OS のパス用で、Windows では `\\` が区切りになる。
 * 両方で切れるようにしてあるのは、Windows でも `C:/Users/...` という書き方が
 * 通るためで、片方だけを見ると取りこぼす。
 */
export function osFileName(path) {
  const s = String(path || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 目次の href に対応する spine index を推測する。
 * ① href のファイル名と一致する section
 * ② 目次内での位置 pos が 0 なら spine 先頭(たいてい表紙)
 * ③ pos-1 から遡り、解決できる項目が見つかったら「その次の章」へ送る
 * ④ 見つからなければ 0
 * @param {object} a
 * @param {string} a.href           目次項目の href
 * @param {string[]} a.sectionHrefs spine 各項目の href
 * @param {string[]} a.tocHrefs     目次を平坦化した href 列
 * @param {number} a.pos            tocHrefs 内での位置(-1 = 不明)
 * @returns {number} spine index
 */
export function guessSectionFor({ href, sectionHrefs, tocHrefs = [], pos = -1 }) {
  const files = sectionHrefs.map(hrefFileName);
  const resolve = (h) => {
    const name = hrefFileName(h);
    return name ? files.indexOf(name) : -1;
  };
  const direct = resolve(href);
  if (direct >= 0) return direct;
  if (pos === 0) return 0;
  for (let p = Math.min(pos, tocHrefs.length) - 1; p >= 0; p--) {
    const i = resolve(tocHrefs[p]);
    if (i >= 0) return Math.min(i + 1, sectionHrefs.length - 1);
  }
  return 0;
}

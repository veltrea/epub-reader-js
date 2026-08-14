// 本文の向き(縦書き/横書き)と操作の向き(ページ送り・進捗スライダー)を決める純粋ロジック。
// DOM も foliate も触らないので、tests/logic.test.mjs から直接テストできる。
//
// 背景: 電子書籍の制作現場では、Kindle で意図どおりに表示されたテンプレートが
// 正しいものとして使い回される。その結果「OPF は縦書き・右綴じを宣言しているのに、
// 本文 CSS の writing-mode が落ちていて横書きで組まれる」本が実際に流通している。
// そこで「本の宣言」と「実際に組まれた結果」を別々に受け取り、突き合わせて判断する。

export const WRITING_MODES = ['auto', 'vertical', 'horizontal'];

// 本の宣言から「縦書きの本」かどうかを推し量る。手掛かりは2つ。
//   1. primary-writing-mode: vertical-*  … 縦書きを明示した慣習メタ(最も確か)
//   2. 右綴じ(dir=rtl) かつ 日本語        … 日本語のリフロー本で右綴じは実質的に縦書き本
//      (横書きの日本語書籍は左綴じが通例。右綴じ横書きはコミック等の固定レイアウトで、
//       固定レイアウトは shouldAutoVertical() 側で除外する)
export function declaresVertical({ primaryWritingMode, dir, languages } = {}) {
  if (String(primaryWritingMode || '').startsWith('vertical')) return true;
  const ja = [].concat(languages || []).some((l) => String(l).toLowerCase().startsWith('ja'));
  return dir === 'rtl' && ja;
}

// 自動縦書き補正を掛けるべきか。「宣言は縦書き」かつ「実際は横書きに組まれた」ときだけ効かせる。
// renderedVertical が null(まだ本文が無い/判定不能)のときは触らない。
export function shouldAutoVertical({ mode, declared, renderedVertical, fixedLayout } = {}) {
  if (mode !== 'auto') return false; // ユーザーが明示指定中は本の判断より優先する
  if (fixedLayout) return false;     // 固定レイアウトは組み直さない
  if (!declared) return false;
  return renderedVertical === false;
}

// 実際に本文へ適用する向き。'auto' は本の CSS に任せる(=向きのCSSを注入しない)。
export function resolveWritingMode({ mode, autoVertical } = {}) {
  if (mode === 'vertical' || mode === 'horizontal') return mode;
  return autoVertical ? 'vertical' : 'auto';
}

// ページ送り・進捗スライダーの向き。'auto' では本の綴じ方向の宣言ではなく
// 「実際に組まれた向き」を最優先する。右綴じ宣言だけ残って本文は横書き、という本で
// 操作系だけ rtl になる(横書きなのに←キーで先へ進む)のを防ぐため。
// rendered が無い初回のみ、本の宣言(naturalDir)で暫定する。
export function resolveDir({ mode, rendered, naturalDir } = {}) {
  if (mode === 'vertical') return 'rtl';
  if (mode === 'horizontal') return 'ltr';
  if (rendered) return rendered.vertical || rendered.rtl ? 'rtl' : 'ltr';
  return naturalDir === 'rtl' ? 'rtl' : 'ltr';
}

// ---------------------------------------------------------------------------
// 綴じ方向(bookDir)の決定 — SPECIFICATION.ja.md §8.4
// ---------------------------------------------------------------------------
// なぜ「章ごとの向き」で決めてはいけないか:
//   縦書きの本でも表紙・前付けは横組みで作られていることが非常に多い。章ごとの向きで
//   ページ送りの左右を決めると、前付けにいる間だけ左右の意味が反転し、
//   **表紙と本文1ページ目を往復するだけで奥付へ到達できなくなる**
//   (青空文庫『吾輩は猫である』上篇自序で実際に発生)。
// したがって:
//   章ごとの dir / vertical … 「いま画面に組まれているもの」。描画を合わせたい用途にだけ使う。
//   本単位の bookDir       … 進捗スライダーの鏡像・左右タップ・矢印キーの向きに使う。

export const BINDINGS = ['auto', 'rtl', 'ltr'];

/** 綴じ方向ボタンの巡回: auto → rtl → ltr → auto。 */
export function nextBinding(cur) {
  const i = BINDINGS.indexOf(cur || 'auto');
  return BINDINGS[(i + 1) % BINDINGS.length];
}

/**
 * 本を開いた時点の暫定 bookDir。
 * @param {object} a
 * @param {string} a.forcedBinding  'auto'|'rtl'|'ltr'(本ごと/全体の設定)
 * @param {string} a.writingMode    'auto'|'vertical'|'horizontal'
 * @param {string} a.hint           OPF の primary-writing-mode(なければ null)
 * @param {string} a.ppd            spine@page-progression-direction
 * @returns {{dir:string, confirmed:boolean}}
 */
export function initialBookDir({ forcedBinding, writingMode, hint, ppd } = {}) {
  if (forcedBinding === 'rtl' || forcedBinding === 'ltr') return { dir: forcedBinding, confirmed: true };
  const h = String(hint || '');
  if (writingMode === 'vertical' || (writingMode === 'auto' && h.startsWith('vertical'))) {
    return { dir: 'rtl', confirmed: true };
  }
  if (writingMode === 'horizontal' || (writingMode === 'auto' && h.startsWith('horizontal'))) {
    return { dir: 'ltr', confirmed: true };
  }
  // ppd は横組みへ変換された本でも rtl のまま残ることがあるので、あくまで暫定値。
  return { dir: ppd === 'rtl' ? 'rtl' : 'ltr', confirmed: false };
}

/**
 * 章が表示されるたびに bookDir を更新する。
 * @param {{dir:string, confirmed:boolean}} state 現在の状態
 * @param {object} obs 観測値
 * @param {string} obs.forcedBinding
 * @param {string} obs.sectionDir   その章の見かけの向き('rtl'|'ltr')
 * @param {boolean} obs.frontMatter 表紙・前付け・奥付か
 * @param {boolean} obs.evidence    向きの証拠になる本文を持つか
 * @returns {{dir:string, confirmed:boolean}}
 */
export function noteSectionDirection(state, { forcedBinding, sectionDir, frontMatter, evidence } = {}) {
  if (forcedBinding === 'rtl' || forcedBinding === 'ltr') return { dir: forcedBinding, confirmed: true };
  if (sectionDir === 'rtl') return { dir: 'rtl', confirmed: true };   // 縦書き/RTL を一度でも見たら確定
  if (!state.confirmed && !frontMatter && evidence) {
    return { dir: 'ltr', confirmed: true };                           // 本文が横組み = ppd は残骸だった
  }
  return state;
}

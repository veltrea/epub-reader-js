// リーダー画面。foliate-view で EPUB を表示し、縦横/RTL・目次・進捗・読み上げを配線。
import { makeBook } from '../foliate-js/view.js';
import * as api from './api.js';
import {
  loadSettings, saveSettings, loadLibrary, loadDict,
  loadTranslationCache, saveTranslationCache,
  loadProfiles, loadUserCSS, saveUserCSS, saveLastRead,
  switchProfile, flushLibrary,
} from './store.js';
import { AutoPager, PRESET_SECONDS } from './autopager.js';
import { PRESET_MINUTES } from './sleeptimer.js';
import { createSharedSleepTimer, systemPower } from './timers.js';
import { storeGet, storeSet } from './api.js';
import { compile as compileDict, prepare as prepareReading } from './dictionary.js';
import { loadLocale, t, applyTranslations } from './i18n.js';
import { openSettings, openDict, applyTheme, promptNumber } from './ui-modals.js';
import { TTSController } from './tts.js';
import { renderSectionVideo, videoTheme, preferredVideoExt } from './video.js';
import { registerTestbus, startTestbus } from './testbus.js';
import { setupMenu, refreshMenu } from './menu.js';
import { enableFileDrop } from './dnd.js';
import * as ts from './typeset.js';
import * as prefs from './prefs.js';
import * as tr from './translate.js';
import {
  WRITING_MODES, declaresVertical, shouldAutoVertical, resolveWritingMode,
  nextBinding, initialBookDir, noteSectionDirection,
} from './writing-mode.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const bookId = params.get('id');

let settings;          // 全体既定
let bookPrefs = {};    // この本だけの上書き(prefs.js。既定と同値なら持たない)
let view;
let tts;
let saveTimer = null;

/** 実際に使う表示設定(本ごとの上書き → 全体既定)。 */
function pref(key) { return prefs.resolvePref(bookPrefs, settings, key); }
async function setPref(key, value) {
  bookPrefs = prefs.setPref(bookPrefs, settings, key, value);
  await prefs.saveBookPrefs(bookId, bookPrefs);
}

// テーマ配色(本文の背景/文字色)。auto/light は本の既定色を尊重(上書きしない)。
const THEME_COLORS = {
  sepia: { bg: '#f4ecd8', fg: '#5b4636' },
  dark: { bg: '#1b1b1c', fg: '#e5e2e3' }, // Shizuka surface-container-low(UI 地 #131314 より一段持ち上げ)
};

/**
 * 本文へ注入する CSS。foliate の setStyles は [pre, post] を受け取り、
 * head の先頭 / 末尾へ振り分ける(SPECIFICATION.ja.md §8.2)。
 *   pre  = 書字方向の「弱い」指定(EBPAJ クラスの既定 + OPF メタ由来の補い)
 *          → 本の CSS より前・詳細度も低いので、本が指定していればそちらが勝つ
 *   post = テーマ・文字サイズ・行間・ユーザー CSS + 書字方向の「強制」指定(!important)
 */
function readerCSS(s) {
  const scale = Math.round((s.fontScale || 1) * 100);
  const lh = s.lineHeight || 1.8;
  let theme = s.theme;
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const col = THEME_COLORS[theme];
  const themeCss = col
    ? `html, body { background: ${col.bg} !important; color: ${col.fg} !important; }
       a { color: inherit !important; }`
    : '';
  const friendly = pref('renderMode') !== 'raw';
  // friendly でだけ効かせる補正(raw = EPUB の指定どおりに描く検版モード)
  const friendlyCss = friendly ? `
    img, picture, svg { max-width: 100% !important; max-height: 100vh; height: auto; object-fit: contain; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"] { display: none; }` : '';

  const pre = `${ts.ebpajClassCSS()}\n${ts.opfHintCSS(bookWritingHint())}`;
  const post = `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { font-size: ${scale}% !important; }
    p, li, div, body { line-height: ${lh} !important; }
    ${friendlyCss}
    ${themeCss}
    ${ts.forcedWritingCSS(effectiveWritingMode())}
    /* ルビの読み(rt)は data-rt に退避し ::after で見た目のみ復元 → 読み上げ対象外にする(S4) */
    rt { font-size: .5em; }
    rt[data-rt]::after { content: attr(data-rt); }
    /* 画像のみページ(表紙・口絵)はここでは触らない。ページ矩形いっぱいへの拡大は
       paginator.js の fillPageWithImage が実測値でインライン指定する(CSS だと段組みの
       箱の大きさが取れず、元画像より大きくできないため)。 */
    /* L2: ユーザーCSS(全書籍共通 → 本別 の順で後勝ち) */
    ${userCSS || ''}
    ${perBookCSS || ''}
  `;
  return [pre, post];
}
let perBookCSS = '';
// 全書籍共通のカスタムCSS。書棚ごとに分けるので settings ではなく store が持つ。
let userCSS = '';

/** OPF の primary-writing-mode(EBPAJ クラスを持たない文書への補いに使う)。 */
function bookWritingHint() {
  return ts.normalizeWritingHint(view?.book?.metadata?.primaryWritingMode);
}

// auto のときの自動縦書き補正フラグ。詳細は maybeAutoVertical() を参照。
let autoVertical = false;

// 実際に本文へ適用する向き。ユーザーが明示指定していればそれ、'auto' なら自動補正の結果。
function effectiveWritingMode() {
  return resolveWritingMode({ mode: pref('writingMode'), autoVertical });
}

// リーダー画面(foliate-view の外側)の背景もテーマに合わせる。
function applyReaderPageTheme(s) {
  let theme = s.theme;
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const col = THEME_COLORS[theme] || (theme === 'light' ? { bg: '#ffffff', fg: '#1a1a1a' } : null);
  if (col) document.getElementById('reader').style.background = col.bg;
}

function applyReaderStyles() {
  try { view.renderer.setStyles?.(readerCSS(settings)); } catch { /* noop */ }
  applyReaderPageTheme(settings);
}

async function getBookFile() {
  // ブラウザ検証: sessionStorage の blob URL、なければ test-books の id.epub
  if (!api.IS_TAURI) {
    const url = sessionStorage.getItem('bookurl:' + bookId);
    if (url) {
      const buf = await (await fetch(url)).arrayBuffer();
      return new File([buf], bookId + '.epub');
    }
  }
  // 拡張子まで再現して File を作る。foliate の makeBook は中身だけでなく**名前でも**
  // 形式を見分ける(CBZ・FBZ は ZIP なので、名前が無いと EPUB として開かれてしまう)。
  const { ext, data } = await api.readBook(bookId);
  return new File([api.blobFromB64(data)], `${bookId}.${ext || 'epub'}`);
}

async function main() {
  // 蔵書・読み辞書・共通CSS は書棚ごとに分かれるので、どれを読むより先に現在の書棚を確かめる。
  profileIndex = await loadProfiles();
  settings = await loadSettings();
  userCSS = await loadUserCSS(settings);
  applyTheme(settings.theme);
  await loadLocale(settings.lang);
  applyTranslations();

  // タイトル表示
  try {
    const lib = await loadLibrary();
    const meta = lib.find((b) => b.id === bookId);
    if (meta) $('#book-title').textContent = meta.title;
  } catch { /* noop */ }

  // 本のオープンに失敗してもバスは生かす(外部からの診断を可能にするため先に起動)
  registerReaderTestbus();
  startTestbus();

  perBookCSS = (await storeGet('css-' + safeId())) || '';
  spreadShift = (await storeGet('spread-' + safeId())) || 0;
  bookPrefs = await prefs.loadBookPrefs(bookId, settings);
  trCache.load(await loadTranslationCache());
  bookFile = await getBookFile();

  setupTimers();
  wireControls();
  enableReaderFileDrop();
  await wireMenu();
  await openBook();
}

let bookFile = null;
let spreadShift = 0;
let bookNaturalDir = 'ltr';
// 本単位の綴じ方向(§8.4)。章ごとの向きではなく、これでページ送り・スライダーを決める。
let bookDir = { dir: 'ltr', confirmed: false };

// 本を(再)オープンする。見開きずらしのトグルでも呼ぶ(foliate-view を作り直してスプレッド再構成)。
async function openBook() {
  // 既存 view があれば破棄。開き直しても同じ位置に戻れるよう、保存を先に確定させる
  // (進捗保存は 800ms デバウンスなので、直前のページ送りが落ちることがある)。
  if (view) {
    if (lastCfi) { try { await storeSet('loc-' + safeId(), lastCfi); } catch { /* noop */ } }
    try { view.close?.(); } catch { /* noop */ }
    view.remove();
  }
  view = document.createElement('foliate-view');
  $('#reader').appendChild(view);
  view.addEventListener('load', onLoad);
  view.addEventListener('relocate', onRelocate);

  // makeBook してから見開きずらしを適用し、book を渡して open
  const book = await makeBook(bookFile);
  applySpreadShift(book);
  applyImageSpreadToBook(book);
  bookNaturalDir = book.dir === 'rtl' ? 'rtl' : 'ltr'; // 強制解除時に戻す本来の綴じ方向
  // 綴じ方向の暫定値(§8.4)。本文を一度も描いていない段階なので confirmed=false のことがある。
  bookDir = initialBookDir({
    forcedBinding: pref('binding'),
    writingMode: pref('writingMode'),
    hint: book.metadata?.primaryWritingMode,
    ppd: bookNaturalDir,
  });
  await view.open(book);
  // 注入CSS(強制縦横を含む)は init より前に渡す。セクション読み込み時点で
  // foliate が body の writing-mode を見て段組みを決めるため。
  applyReaderStyles();

  const savedLoc = await storeGet('loc-' + safeId());
  await view.init({ lastLocation: savedLoc || undefined, showTextStart: true });

  applyReadingDirection();
  applyForcedMargin();
  lastSpreadKey = null;   // view を作り直したので前回の適用状態は無効
  applyTextSpread();
  applyForcedAspect();
  updateLayoutButtons();
  buildTOC();

  // 読み上げ制御(view を作り直したので再生成)
  tts = new TTSController(view, () => settings, onTTSState, onTTSError);
  await refreshDict();
}

// 読み辞書を読み直してコンパイルし、TTS へ渡す。
// エンジンのユーザー辞書は使わない(短い登録語が長い熟語を食い荒らすため。§10.2)。
let compiledDict = [];
async function refreshDict() {
  try { compiledDict = compileDict(await loadDict()); } catch { compiledDict = []; }
  tts?.setDictionary(compiledDict);
  return compiledDict;
}

// 固定レイアウト(写真集)で見開きのペアを1ページずらす。
// 分割見開き画像が「表紙の枚数などで左右が割れる」場合に、先頭を寄せてペアを揃える。
function applySpreadShift(book) {
  if (!book?.sections?.length) return;
  if (book.rendition?.layout !== 'pre-paginated') return; // FXL のみ
  if (!spreadShift) return; // 0=本の指定/自動を尊重
  const lead = book.dir === 'rtl' ? 'right' : 'left';
  book.sections[0].pageSpread = lead; // 先頭をペア方向へ→以降のペアが1つずれる
}

async function toggleSpreadShift() {
  spreadShift = spreadShift ? 0 : 1;
  await storeSet('spread-' + safeId(), spreadShift);
  await openBook();
}

// 見開きずらしは FXL のときだけ、縦横の強制・本文見開きはリフロー本のときだけ意味がある。
function updateLayoutButtons() {
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  const fxl = !!view.isFixedLayout;
  show('btn-spread', fxl);
  show('btn-writing', !fxl);
  show('btn-textspread', !fxl);
  updateWritingModeButton();
  updateModeButtons();
}

// 「押下で巡回・長押しでメニュー」の値(本のデータからは決められないもの)をボタンへ反映する。
function updateModeButtons() {
  const setMode = (id, mode, titleKey) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.dataset.mode = mode;
    el.setAttribute('data-i18n-title', titleKey);
    el.title = t(titleKey);
  };
  const rm = pref('renderMode') || 'friendly';
  setMode('btn-render', rm, 'reader.render.' + rm);
  const bd = pref('binding') || 'auto';
  // auto のときは「いま何と判定しているか」も伝える
  const bdTitle = bd === 'auto' ? t('reader.binding.auto') + `（${t('reader.binding.' + bookDir.dir)}）` : t('reader.binding.' + bd);
  const bdEl = document.getElementById('btn-binding');
  if (bdEl) { bdEl.dataset.mode = bd; bdEl.removeAttribute('data-i18n-title'); bdEl.title = bdTitle; }
  const is = pref('imageSpread') || 'auto';
  setMode('btn-imgspread', is, 'reader.imageSpread.' + is);
  const tsp = pref('textSpread') || 'auto';
  setMode('btn-textspread', tsp, 'reader.textSpread.' + tsp);
  const asp = document.getElementById('btn-aspect');
  if (asp) {
    const a = prefs.parseAspect(bookPrefs.aspect);
    asp.classList.toggle('on', !!a);
    asp.title = a ? t('reader.aspectOn', { ratio: prefs.aspectLabel(a) }) : t('reader.aspect');
  }
  const trBtn = document.getElementById('btn-translate');
  if (trBtn) trBtn.classList.toggle('on', $('#tr-pane').classList.contains('show'));
  // メニューのチェックも同じ値で組み直す(ツールバーで変えてもメニューが古いままにならない)。
  if (autoPager) void syncMenuState();
}

// テストバス: リーダーを外部から駆動・観測する(computer-use 非依存)
function registerReaderTestbus() {
  const cur = () => view.renderer?.getContents?.()[0] || {};
  registerTestbus({
    state: async () => {
      const c = cur();
      return {
        page: 'reader', bookId,
        title: document.querySelector('#book-title')?.textContent || '',
        sectionIndex: c.index ?? null,
        sectionCount: view.book?.sections?.length ?? null,
        fraction: lastFraction,
        pct: Math.round(lastFraction * 100),
        dir: view.book?.dir || 'ltr',
        playing: !!tts?.playing, paused: !!tts?.paused,
      };
    },
    page: async ({ dir }) => {
      if (dir === 'left') await view.goLeft();
      else if (dir === 'right') await view.goRight();
      else if (dir === 'prev') await view.prev();
      else await view.next();
      return { fraction: lastFraction };
    },
    gotoFraction: async ({ fraction }) => { await view.goToFraction(fraction); return { fraction: lastFraction }; },
    gotoHref: async ({ href }) => { await view.goTo(href); return { fraction: lastFraction }; },
    toc: async () => {
      const flat = [];
      const walk = (items, depth) => { for (const it of items || []) { flat.push({ label: it.label, href: it.href, depth }); if (it.subitems) walk(it.subitems, depth + 1); } };
      walk(view.book?.toc, 0);
      return flat;
    },
    currentText: async ({ max = 400 } = {}) => {
      const doc = cur().doc;
      const txt = (doc?.body?.textContent || '').replace(/\s+/g, ' ').trim();
      return { length: txt.length, text: txt.slice(0, max) };
    },
    ttsPlay: async () => { tts.play(await refreshDict()); return { playing: tts.playing }; },
    ttsPause: async () => { tts.pause(); return { paused: tts.paused }; },
    ttsResume: async () => { tts.resume(); return { paused: tts.paused }; },
    ttsStop: async () => { tts.stop(); return { playing: tts.playing }; },
    ttsState: async () => ({ playing: !!tts?.playing, paused: !!tts?.paused }),
    ttsSaveSection: async ({ filenameBase = 'testbus' } = {}) => {
      const b64 = await tts.makeSectionWavB64();
      const name = filenameBase.replace(/[\\/:*?"<>|]/g, '_') + '.wav';
      const path = await api.saveBytes(settings.ttsSaveDir, name, b64, 'audio/wav');
      return { path };
    },
    // 章を朗読動画として書き出す(検証用。実時間で録画するため章の長さぶん待つ)
    ttsSaveVideo: async ({ filenameBase = 'testbus', monitor = false, orientation } = {}) => {
      window.__videoErr = null; window.__videoDone = null;
      try {
        const segments = await tts.synthSection();
        const canvas = document.createElement('canvas');
        const ori = orientation || currentOrientation();
        const { b64, ext, duration } = await renderSectionVideo(canvas, segments, videoTheme(settings), { monitor, orientation: ori });
        window.__videoStage = 'saving:' + b64.length;
        const name = filenameBase.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
        const path = await api.saveBytes(settings.ttsSaveDir, name, b64, ext === 'mp4' ? 'video/mp4' : 'video/webm');
        window.__videoDone = { path, ext, duration, bytesB64: b64.length };
        return window.__videoDone;
      } catch (e) { window.__videoErr = String(e && (e.stack || e.message || e)); throw e; }
    },
    videoDiag: async () => ({ err: window.__videoErr || null, done: window.__videoDone || null, stage: window.__videoStage || null, info: window.__videoInfo || null }),
    // 動画書き出しの能力チェック(WKWebView で MediaRecorder/captureStream が使えるか)
    mediaCaps: async () => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      let canCapture = false, streamTracks = 0;
      try { const st = c.captureStream?.(30); canCapture = !!st; streamTracks = st?.getVideoTracks?.().length || 0; } catch { /* noop */ }
      const has = (m) => { try { return window.MediaRecorder && MediaRecorder.isTypeSupported(m); } catch { return false; } };
      return {
        hasMediaRecorder: typeof window.MediaRecorder !== 'undefined',
        canvasCaptureStream: canCapture, streamTracks,
        hasAudioContext: typeof (window.AudioContext || window.webkitAudioContext) !== 'undefined',
        mp4_h264_aac: has('video/mp4;codecs=avc1.42E01E,mp4a.40.2'),
        mp4_plain: has('video/mp4'),
        webm_vp9: has('video/webm;codecs=vp9,opus'),
        webm_vp8: has('video/webm;codecs=vp8,opus'),
        webm_plain: has('video/webm'),
      };
    },
    progressDir: async () => {
      const s = document.getElementById('progress');
      return { dir: view.book?.dir || 'ltr', sliderDirection: getComputedStyle(s).direction, value: parseFloat(s.value) };
    },
    getSettings: async () => ({ ...settings }),
    setSetting: async ({ key, value }) => { settings[key] = value; await saveSettings(settings); applyReaderStyles(); return { [key]: settings[key] }; },
    // M2 しおり
    bookmarkAdd: async () => { await addBookmark(); return { count: (await loadBookmarks()).length }; },
    bookmarkList: async () => await loadBookmarks(),
    bookmarkClear: async () => { await saveBookmarks([]); await renderBookmarks(); return { ok: true }; },
    // 強制縦書き / 強制横書き
    writingMode: async () => {
      const doc = cur().doc;
      return {
        mode: pref('writingMode') || 'auto',
        effective: effectiveWritingMode(),
        autoVertical,                                   // 壊れた縦書き本を補正中か
        declaresVertical: bookDeclaresVertical(),       // 本の宣言(メタ/綴じ方向)は縦書きか
        primaryWritingMode: view.book?.metadata?.primaryWritingMode || null,
        computed: doc ? doc.defaultView.getComputedStyle(doc.body).writingMode : null,
        dir: view.book?.dir || 'ltr',
        naturalDir: bookNaturalDir,
        buttonShown: document.getElementById('btn-writing')?.style.display !== 'none',
      };
    },
    setWritingMode: async ({ mode }) => {
      await setPref('writingMode', WRITING_MODES.includes(mode) ? mode : 'auto');
      applyWritingMode();
      const doc = cur().doc;
      return {
        mode: pref('writingMode'),
        computed: doc ? doc.defaultView.getComputedStyle(doc.body).writingMode : null,
        dir: view.book?.dir || 'ltr',
      };
    },
    // M6 強制余白
    toggleMargin: async () => { await toggleForcedMargin(); return { forceMargin: settings.forceMargin, hasClass: $('#reader').classList.contains('force-margin') }; },
    marginState: async () => ({ forceMargin: settings.forceMargin, hasClass: $('#reader').classList.contains('force-margin') }),
    // M5 検証: 現在ページ先頭語から読み上げ開始(playFrom 経路)
    ttsFromHere: async () => {
      const doc = cur().doc;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent.trim()) node = walker.nextNode();
      if (!node) return { started: false };
      const range = doc.createRange();
      range.setStart(node, 0); range.setEnd(node, Math.min(3, node.textContent.length));
      tts.playFrom(range, []); // await しない(読み上げループを待つとテストバスが固まる)
      return { started: tts.playing };
    },
    tapZones: async () => ({ left: !!document.getElementById('tap-left'), right: !!document.getElementById('tap-right') }),
    // 画像ページの実測(表紙/口絵が小さい問題の検証用)。ページ矩形と画像の実描画サイズを返す。
    imagePageInfo: async () => {
      const c = cur(); const doc = c.doc; const win = doc?.defaultView;
      if (!doc || !win) return { error: 'no doc' };
      const de = doc.documentElement;
      const cs = win.getComputedStyle(de);
      const el = doc.body.querySelector('img, svg');
      const r = el?.getBoundingClientRect();
      const est = el ? win.getComputedStyle(el) : null;
      return {
        sectionIndex: c.index ?? null,
        imagePage: doc.body.hasAttribute('data-image-page'),
        text: (doc.body.textContent || '').replace(/\s+/g, '').slice(0, 40),
        writingMode: cs.writingMode,
        win: { innerWidth: win.innerWidth, innerHeight: win.innerHeight },
        html: {
          clientWidth: de.clientWidth, clientHeight: de.clientHeight,
          styleW: de.style.width, styleH: de.style.height,
          padding: cs.padding, columnWidth: cs.columnWidth, columnGap: cs.columnGap,
        },
        el: el ? {
          tag: el.tagName,
          natural: { w: el.naturalWidth ?? null, h: el.naturalHeight ?? null },
          rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
          css: { width: est.width, height: est.height, maxWidth: est.maxWidth, maxHeight: est.maxHeight, objectFit: est.objectFit },
          parent: (() => { const p = el.parentElement; const pr = p?.getBoundingClientRect(); const pc = p ? win.getComputedStyle(p) : null; return p ? { tag: p.tagName, w: Math.round(pr.width), h: Math.round(pr.height), cssW: pc.width, cssH: pc.height } : null; })(),
        } : null,
      };
    },
    // ツールバーの自動表示: 指定 Y(未指定なら現状)でのバーの可視状態を返す
    barsState: async ({ y, contentY } = {}) => {
      if (y != null) updateBarsByY(y);
      // contentY: 本文 iframe の中でマウスを動かした場合(座標変換の経路を実際に通す)
      if (contentY != null) {
        const doc = cur().doc;
        const win = doc?.defaultView;
        if (win) doc.dispatchEvent(new win.MouseEvent('mousemove', { view: win, clientY: contentY, bubbles: true }));
      }
      const vis = (id) => {
        const el = document.getElementById(id);
        return { show: el.classList.contains('show'), opacity: getComputedStyle(el).opacity };
      };
      return { edge: BAR_EDGE, edgeBottom: BAR_EDGE_BOTTOM, height: window.innerHeight,
        top: vis('topbar'), bottom: vis('botbar') };
    },
    // 見開きずらし(FXL)
    fxlInfo: async () => ({ isFixedLayout: !!view.isFixedLayout, spreadShift, buttonShown: document.getElementById('btn-spread')?.style.display !== 'none' }),
    toggleSpread: async () => { await toggleSpreadShift(); return { spreadShift }; },
    // L1 検索: query の全文検索結果件数と先頭数件の抜粋を返す
    search: async ({ query, max = 3, limit = SEARCH_LIMIT }) => {
      const items = [];
      try {
        // 上限を持たせないと「の」のような語で全 64 章を舐め続け、アプリが返らなくなる。
        for await (const r of view.search({ query })) {
          if (r === 'done' || items.length >= limit) break;
          if (r.subitems) for (const s of r.subitems) {
            if (items.length >= limit) break;
            items.push({ label: r.label, match: s.excerpt?.match, pre: s.excerpt?.pre });
          }
        }
      } finally { try { view.clearSearch(); } catch { /* noop */ } }
      return { count: items.length, truncated: items.length >= limit, sample: items.slice(0, max) };
    },
    // L2 カスタムCSS
    getCSS: async () => ({ common: userCSS || '', book: perBookCSS || '' }),
    setCSS: async ({ common, book }) => {
      if (common != null) { userCSS = common; await saveUserCSS(userCSS); }
      if (book != null) perBookCSS = book;
      await storeSet('css-' + safeId(), perBookCSS);
      applyReaderStyles();
      const doc = cur().doc; const p = doc?.querySelector('p');
      return { applied: true, sampleColor: p ? doc.defaultView.getComputedStyle(p).color : null };
    },
    computedFont: async () => {
      const doc = cur().doc; const win = doc?.defaultView;
      const htmlFs = win ? win.getComputedStyle(doc.documentElement).fontSize : null;
      const bg = win ? win.getComputedStyle(doc.body).backgroundColor : null;
      return { htmlFontSize: htmlFs, bodyBg: bg };
    },
    rubyInfo: async () => {
      const doc = cur().doc;
      const rts = [...(doc?.querySelectorAll('rt') || [])];
      return { count: rts.length, stashed: rts.filter((r) => r.hasAttribute('data-rt')).length, textIncludesReading: rts.some((r) => r.textContent) };
    },
    highlightedText: async () => {
      // 現在ハイライト中の文(TTS)。CSS Custom Highlight の範囲テキスト。
      const doc = cur().doc; const win = doc?.defaultView;
      const h = win?.CSS?.highlights?.get?.('tts');
      if (!h) return { text: '' };
      const r = [...h][0];
      return { text: r ? r.toString().replace(/\s+/g, ' ').trim() : '' };
    },
    // ツールバーの実測。ボタンが増えたときに枠からはみ出していないかを数値で見る。
    chromeState: async () => {
      const of = (bar) => [...document.querySelectorAll(`#${bar} > *`)].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.id || el.tagName.toLowerCase(), x: Math.round(r.x), w: Math.round(r.width), hidden: el.style.display === 'none' };
      });
      const overflow = (bar) => {
        const items = of(bar).filter((i) => !i.hidden);
        const right = items.length ? Math.max(...items.map((i) => i.x + i.w)) : 0;
        const left = items.length ? Math.min(...items.map((i) => i.x)) : 0;
        return { right: Math.round(right - window.innerWidth), left: Math.round(-left) };
      };
      return {
        width: window.innerWidth, height: window.innerHeight,
        top: of('topbar'), bottom: of('botbar'),
        overflowTop: overflow('topbar'), overflowBottom: overflow('botbar'),
      };
    },
    // ---- 表示エンジンの解釈(表示モード・綴じ方向・見開き・判型) ----
    displayState: async () => ({
      renderMode: pref('renderMode'),
      binding: pref('binding'),
      bookDir: bookDir.dir,
      bookDirConfirmed: bookDir.confirmed,
      effectiveDir: effectiveDir(),
      imageSpread: pref('imageSpread'),
      textSpread: pref('textSpread'),
      aspect: bookPrefs.aspect || '',
      detectedAspect: detectBookAspect(),
      fixedLayout: !!view.isFixedLayout,
      bookPrefs: { ...bookPrefs },
    }),
    setDisplay: async ({ renderMode, binding, imageSpread, textSpread, aspect } = {}) => {
      if (renderMode) { await setPref('renderMode', renderMode); for (const c of view.renderer?.getContents?.() || []) applyRenderModeToDoc(c.doc); applyReaderStyles(); try { view.renderer?.render?.(); } catch { /* noop */ } }
      if (binding) { await setPref('binding', binding); applyReadingDirection(); }
      if (textSpread) { await setPref('textSpread', textSpread); applyTextSpread(); }
      if (aspect !== undefined) {
        bookPrefs = prefs.setPref(bookPrefs, settings, 'aspect', prefs.aspectToString(prefs.parseAspect(aspect)));
        await prefs.saveBookPrefs(bookId, bookPrefs);
        applyForcedAspect();
      }
      if (imageSpread) { await setPref('imageSpread', imageSpread); if (view.isFixedLayout) await openBook(); }
      updateModeButtons();
      const doc = cur().doc;
      const el = doc?.body?.querySelector('img, svg');
      return {
        renderMode: pref('renderMode'), binding: pref('binding'), effectiveDir: effectiveDir(),
        imageSpread: pref('imageSpread'), textSpread: pref('textSpread'), aspect: bookPrefs.aspect || '',
        columnCount: doc ? doc.defaultView.getComputedStyle(doc.documentElement).columnCount : null,
        imageRect: el ? (({ width, height }) => ({ w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect()) : null,
        preserveAspectRatio: el?.getAttribute?.('preserveAspectRatio') || null,
      };
    },
    // 読み辞書(レイヤー付き前処理)の適用結果。エンジンを起動せずに検証できる。
    dictPrepare: async ({ text }) => {
      const { prepare } = await import('./dictionary.js');
      const r = prepare(text, await loadDict());
      return { text: r.text, gapCount: r.gapCount, silenceGaps: r.silenceGaps, changed: r.changed };
    },
    dictGet: async () => await loadDict(),
    dictSet: async ({ entries }) => {
      const { saveDict } = await import('./store.js');
      const { normalizeList } = await import('./dictionary.js');
      const list = normalizeList(entries || []);
      await saveDict(list);
      await refreshDict();
      return list;
    },
    // 目次(リンク切れ救済つき)
    // サイドバー(目次/しおり)の開閉。検証から画面の状態を直接動かせるようにしておく。
    sideOpen: async ({ kind = 'toc' } = {}) => {
      if (kind === 'bm') await openBM(); else openTOC();
      return { side: sideKind(), width: document.getElementById('side').offsetWidth };
    },
    sideClose: async () => { closeSide(); return { side: sideKind() }; },
    sideState: async () => {
      const el = document.getElementById('side');
      const cs = getComputedStyle(el);
      return {
        side: sideKind(), width: el.offsetWidth,
        title: document.getElementById('side-title')?.textContent || '',
        // 診断用。サイドバーが開かない・目次の折りたたみ(§9.9)を外から確かめるため。
        cls: el.className, cssWidth: cs.width, display: cs.display,
        stageDisplay: getComputedStyle(document.getElementById('stage')).display,
        tocRows: document.querySelectorAll('#toc-list .toc-row').length,
        tocOpen: document.querySelectorAll('#toc-list li.open').length,
        tocTwists: document.querySelectorAll('#toc-list .toc-twist:not(.leaf)').length,
        tocVisibleRows: [...document.querySelectorAll('#toc-list .toc-row')]
          .filter((r) => r.offsetParent !== null).length,
      };
    },
    searchOpen: async () => { openSearch(); return { open: true }; },
    searchClose: async () => { closeSearch(); return { open: false }; },
    tocJump: async ({ index = 0 } = {}) => {
      const link = tocLinks[index];
      if (!link) return { ok: false };
      const ok = await goToTarget(link.href, index);
      return { ok, href: link.href, fraction: lastFraction };
    },
    // 対訳
    translateState: async () => ({
      open: trOpen,
      rect: (({ x, width, height }) => ({ x: Math.round(x), w: Math.round(width), h: Math.round(height) }))($('#tr-pane').getBoundingClientRect()),
      viewportWidth: window.innerWidth,
      rows: [...document.querySelectorAll('#tr-body .tr-item')].map((r) => ({
        src: r.querySelector('.tr-src')?.textContent || '',
        dst: r.querySelector('.tr-dst')?.textContent || '',
        state: r.querySelector('.tr-dst')?.className.replace('tr-dst', '').trim() || 'done',
      })),
      status: document.getElementById('tr-status')?.textContent || '',
    }),
    // ウィンドウにファイルを落としたのと同じことをする(本物のドラッグは外から起こせない)。
    dropFiles: async ({ paths = [] } = {}) => {
      if (!paths.length) return { ok: false, reason: 'no-paths' };
      sessionStorage.setItem('shelf-import', JSON.stringify(paths));
      setTimeout(() => { void backToShelf(); }, 0);
      return { ok: true, paths };
    },
    translateToggle: async () => { toggleTranslate(); return { open: trOpen }; },
    translateRefresh: async () => { await refreshTranslation(true); return { open: trOpen }; },
    // 対訳の行をダブルクリックしたときと同じことをして、本文が光ったかを返す。
    translateDblClick: async ({ index = 0 } = {}) => {
      const row = document.querySelectorAll('#tr-body .tr-item')[index];
      if (!row) return { ok: false, reason: 'no-row' };
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const out = [];
      for (const c of view?.renderer?.getContents?.() || []) {
        const h = c.doc?.defaultView?.CSS?.highlights?.get('tr-hit');
        for (const r of h || []) out.push((r.toString() || '').slice(0, 30));
      }
      return { ok: out.length > 0, src: row.querySelector('.tr-src')?.textContent?.slice(0, 30) || '', lit: out };
    },
    ttsHighlightInfo: async () => {
      // 診断用: 各ハイライト名の range 数とテキスト(先頭20字)。読み上げ済み残留などの検証に使う。
      const out = {};
      for (const c of view.renderer?.getContents?.() || []) {
        const hs = c.doc?.defaultView?.CSS?.highlights;
        if (!hs) continue;
        for (const [name, h] of hs.entries()) {
          out[name] = (out[name] || []).concat([...h].map((r) => r.toString().replace(/\s+/g, ' ').trim().slice(0, 20)));
        }
      }
      return out;
    },

    // ---- 自動ページ送り ----
    autoPagerStart: async ({ seconds = 30 }) => { startAutoPager(seconds); return autoPagerState(); },
    autoPagerStop: async () => { stopAutoPager(); return autoPagerState(); },
    // 締め切りを現在へ引き寄せて 1 回ぶん送らせる(待たずに検証するため)。
    autoPagerFire: async () => { await autoPager.fireNow(); return { ...autoPagerState(), fraction: lastFraction }; },
    autoPagerState: async () => autoPagerState(),

    // ---- スリープタイマー ----
    sleepTimerStart: async ({ minutes = 30, seconds = null, action = null }) => {
      if (action) sleepTimer.setAction(action);
      if (seconds != null) sleepTimer.startForTest(seconds);
      else startSleepTimer(minutes);
      void syncMenuState();
      return sleepTimerState();
    },
    sleepTimerCancel: async () => { cancelSleepTimer(); return sleepTimerState(); },
    sleepTimerFire: async () => { sleepTimer.fireNow(); return sleepTimerState(); },
    sleepTimerShutdownCancel: async () => { sleepTimer.cancelShutdownCountdown(); return sleepTimerState(); },
    sleepTimerState: async () => sleepTimerState(),
    // 画面内の「戻る」と同じ経路で書棚へ帰る(タイマーの引き継ぎを確かめるため、
    // navigate ではなくこちらを通す必要がある)。
    backToShelf: async () => { void backToShelf(); return { navigating: 'index.html' }; },
    // メニューへ写している値(チェックマークの根拠)。
    menuState: async () => menuState(),
  });
}

function autoPagerState() {
  return {
    running: !!autoPager?.isRunning,
    seconds: autoPager?.seconds,
    remaining: autoPager?.remainingText,
    holding: !!autoPager?.isHolding,
    status: document.getElementById('timer-status')?.textContent || '',
  };
}

function sleepTimerState() {
  return {
    active: !!sleepTimer?.isActive,
    minutes: sleepTimer?.lastMinutes,
    action: sleepTimer?.action,
    remaining: sleepTimer?.remainingText,
    shutdownCountdown: sleepTimer?.shutdownCountdown ?? null,
    powerRequest: sleepTimer?.power?.lastRequest ?? null,
    status: document.getElementById('timer-status')?.textContent || '',
  };
}

function safeId() { return (bookId || '').replace(/[^a-zA-Z0-9_-]/g, ''); }

function onLoad({ detail }) {
  const doc = detail.doc;
  applyRenderModeToDoc(doc);
  // 画像のみページ(表紙・口絵・挿絵)の判定。印を付けるだけで、実際の拡大は
  // paginator.js の fillPageWithImage が行う(ページ矩形いっぱい + アスペクト比維持)。
  // 本文がほぼ無く画像が1枚だけ、を条件にする(キャプション付きの図は対象外)。
  try {
    const body = doc.body;
    const text = (body?.textContent || '').replace(/\s/g, '');
    const imgs = body?.querySelectorAll('img, svg') || [];
    if (imgs.length === 1 && text.length < 8) body.setAttribute('data-image-page', '');
    else body?.removeAttribute('data-image-page');
  } catch { /* noop */ }
  // S4: ルビの読み(rt)を textContent から外し、::after で見た目だけ復元
  //     → foliate の TTS 抽出(textContent ベース)が rt を読まなくなる。ルビ表示は保つ。
  try {
    doc.querySelectorAll('rt').forEach((rt) => {
      if (rt.hasAttribute('data-rt')) return;
      const reading = rt.textContent;
      if (reading) { rt.setAttribute('data-rt', reading); rt.textContent = ''; }
    });
  } catch { /* noop */ }
  // M3: マウスホイールでページ送り(セクション文書内のwheelを拾う。1ノッチ=1ページ・スロットル)
  try {
    doc.addEventListener('wheel', onWheel, { passive: false });
  } catch { /* noop */ }
  // M5: 語をダブルクリック → その位置から読み上げ開始
  try {
    doc.addEventListener('dblclick', onDblClick);
  } catch { /* noop */ }
  // 本文は iframe の中なので、親ドキュメントには mousemove が届かない。
  // ツールバーの自動表示のため、セクション文書側でも位置を拾って親の座標系へ変換する。
  try {
    doc.addEventListener('mousemove', onContentMouseMove, { passive: true });
  } catch { /* noop */ }
  // 本文で右クリック → 選択語を読み上げ辞書へ登録(§9.7)
  try {
    doc.addEventListener('contextmenu', onContentContextMenu);
  } catch { /* noop */ }
  // 縦書きのつもりで作られたのに横書きで組まれてしまう本を救う(auto のときだけ)。
  maybeAutoVertical(doc);
  // 章ごとに向きが違う本もあるので、読み込むたびに本単位の綴じ方向を見直す。
  observeSection(doc);
  applyReadingDirection();
}

// friendly(既定)の補正を 1 つの文書へ適用/解除する。
// raw は「EPUB の指定どおりに描いた姿」を見る検版モードなので、補正を全部止める。
function applyRenderModeToDoc(doc) {
  if (!doc?.body) return;
  if (pref('renderMode') === 'raw') {
    ts.restoreSVGImages(doc);
    ts.clearHangingIndent(doc);
    return;
  }
  ts.normalizeSVGImages(doc);   // 表紙の preserveAspectRatio="none" による潰れを直す
}

// 実際にレンダリングされた本文の向き。本の「宣言」ではなく、いま画面に出ている組み方を返す。
// 判定は paginator.js の getDirection() と同じ(computed の writing-mode と direction)。
function renderedDirection(doc) {
  try {
    const d = doc || view.renderer?.getContents?.()[0]?.doc;
    if (!d?.body) return null;
    const cs = d.defaultView.getComputedStyle(d.body);
    return {
      vertical: cs.writingMode.startsWith('vertical'),
      rtl: cs.direction === 'rtl' || d.body.dir === 'rtl' || d.documentElement.dir === 'rtl',
    };
  } catch { return null; }
}

// 本の宣言(メタ・綴じ方向・言語)から「縦書きの本」かを推し量る。判定は writing-mode.js。
function bookDeclaresVertical() {
  return declaresVertical({
    primaryWritingMode: view.book?.metadata?.primaryWritingMode,
    dir: bookNaturalDir,
    languages: view.book?.metadata?.language,
  });
}

// 本の宣言は縦書きなのに横書きで組まれてしまう本を、縦書きへ補正する。
function maybeAutoVertical(doc) {
  if (autoVertical) return; // すでに補正済み
  const d = renderedDirection(doc);
  const ok = shouldAutoVertical({
    mode: pref('writingMode'),
    declared: bookDeclaresVertical(),
    renderedVertical: d ? d.vertical : null,
    fixedLayout: view.isFixedLayout,
  });
  if (!ok) return;
  autoVertical = true;
  // load ハンドラの中で再レイアウト(refreshDirection)を起こさないよう、一度抜けてから適用する。
  setTimeout(() => applyWritingMode(), 0);
}

// ---- ツールバーの自動表示(画面の上端/下端に近づいたときだけ出す) ----
// 端からこの距離(px)以内でバーを出す。下バーは2段(約96px)あるので、
// バーの上でカーソルを動かしただけで消えないよう、バー自身より広く取る。
const BAR_EDGE = 80;
const BAR_EDGE_BOTTOM = 110;
let barPinned = false; // つまみをドラッグ中など、離れても隠さない

function showBar(el, on) { el.classList.toggle('show', on); }

function updateBarsByY(y) {
  if (barPinned) return;
  const h = window.innerHeight;
  showBar($('#topbar'), y <= BAR_EDGE);
  showBar($('#botbar'), y >= h - BAR_EDGE_BOTTOM);
}

function hideBars() {
  if (barPinned) return;
  showBar($('#topbar'), false);
  showBar($('#botbar'), false);
}

// iframe 内の座標 → 親ウィンドウの Y。固定レイアウトの transform: scale() も補正する。
function onContentMouseMove(e) {
  try {
    const frame = e.view?.frameElement;
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    const scale = frame.offsetHeight ? r.height / frame.offsetHeight : 1;
    updateBarsByY(r.top + e.clientY * scale);
  } catch { /* noop */ }
}

function setupAutoHideBars() {
  document.addEventListener('mousemove', (e) => updateBarsByY(e.clientY), { passive: true });
  // ウィンドウ外へ出た/フォーカスを失ったら畳む。
  // 本文 iframe へ入ったときにも mouseleave が飛ぶ実装があるので、
  // カーソルがまだウィンドウ内にいる場合は畳まない(点滅防止)。
  document.addEventListener('mouseleave', (e) => {
    const inside = e.clientX >= 0 && e.clientX <= window.innerWidth
      && e.clientY >= 0 && e.clientY <= window.innerHeight;
    if (!inside) hideBars();
  });
  window.addEventListener('blur', hideBars);
  // スライダーのドラッグ中はカーソルがバーの外へ出ても隠さない
  for (const bar of [$('#topbar'), $('#botbar')]) {
    bar.addEventListener('pointerdown', () => { barPinned = true; });
  }
  document.addEventListener('pointerup', (e) => {
    if (!barPinned) return;
    barPinned = false;
    updateBarsByY(e.clientY); // 放した位置で判定(端から離れていれば畳む)
  });
  // 起動直後だけ少し見せて、操作系の存在を知らせる
  showBar($('#topbar'), true);
  showBar($('#botbar'), true);
  setTimeout(hideBars, 2200);
}

let wheelLock = 0;
function onWheel(e) {
  const now = Date.now();
  // 縦回転(deltaY)は向きによらず下=進む。横方向(deltaX)は「画面上でどちらへ動かすと先へ進むか」が
  // 向きで変わる。rtl(縦書き・右綴じ)ではページが左へ流れるので、左向きのスワイプが「進む」。
  const dx = effectiveDir() === 'rtl' ? -e.deltaX : e.deltaX;
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : dx;
  if (Math.abs(d) < 4) return;
  e.preventDefault();
  if (now - wheelLock < 350) return; // スロットル
  wheelLock = now;
  autoPager?.noteManualTurn();
  if (d > 0) view.next(); else view.prev();
}

async function onDblClick(e) {
  try {
    const doc = e.target?.ownerDocument;
    const sel = doc?.defaultView?.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0).cloneRange();
    await tts.playFrom(range, await refreshDict());
  } catch (err) { console.error('dblclick TTS', err); }
}

let lastFraction = 0;
let lastCfi = null;
function onRelocate({ detail }) {
  // fraction は稀に NaN や 0…1 外になる。スライダーへ渡す前に必ず丸めてクランプする(§8.16)。
  const raw = detail.fraction;
  const frac = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));
  lastFraction = frac;
  if (detail.cfi) lastCfi = detail.cfi;
  // ページが変わったら、対訳の行を光らせた印は消す(前ページの塗りが残らないように)。
  clearPassageFlash();
  $('#progress').value = frac;
  // トラックの塗り分け位置(読んだ側をアクセント色にする)を CSS へ渡す。
  $('#progress').style.setProperty('--track-p', String(frac));
  $('#pct').textContent = Math.round(frac * 100) + '%';
  // 書字方向が確定したこの時点で、ぶら下げインデントのずれを直す(§8.12)。
  // 1 文書につき 1 回だけ効く(内部で印を付けている)。
  if (pref('renderMode') !== 'raw') {
    for (const c of view.renderer?.getContents?.() || []) {
      try { ts.fixHangingIndent(c.doc); } catch { /* noop */ }
    }
  }
  observeSection();
  applyReadingDirection();
  applyTextSpread();          // 向きが後から確定する本があるので毎回見る(変化時だけ組み直す)
  syncTOCCurrent(detail.tocItem);
  scheduleTranslate();
  // 進捗保存(デバウンス)
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (detail.cfi) await storeSet('loc-' + safeId(), detail.cfi);
      // 本棚のヒーロー(読みかけ)表示用: 進捗率と最後に読んだ本
      await storeSet('frac-' + safeId(), frac);
      await saveLastRead({ id: bookId, at: Date.now() });
    } catch { /* noop */ }
  }, 800);
}

// 目次。項目は「平坦化した位置」を覚えておく(リンク切れ救済で使う。§8.13)。
let tocHrefs = [];
let tocLinks = [];   // [{href, a, li}]  li は開閉に使う(§9.9)

// 開閉の三角。閉じているときは右向き、開くと CSS の回転で下向きになる。
const TOC_TWIST_SVG =
  '<svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">' +
  '<path d="M1 1l5 4-5 4" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

// [feat:toc-fold][reader] 目次の枝を折りたたむ
/** 子を持つ項目を開く・閉じる(§9.9)。 */
function setTOCOpen(li, open) {
  if (!li || !li.dataset.hasKids) return;
  li.classList.toggle('open', open);
  const tw = li.querySelector(':scope > .toc-row > .toc-twist');
  if (tw) tw.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function buildTOC() {
  const list = $('#toc-list');
  tocHrefs = []; tocLinks = [];
  const toc = view.book?.toc;
  if (!toc || !toc.length) { list.innerHTML = ''; return; }
  const render = (items) => {
    const ol = document.createElement('ol');
    for (const it of items) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'toc-row';

      const hasKids = !!it.subitems?.length;
      const tw = document.createElement('button');
      tw.type = 'button';
      tw.className = 'toc-twist' + (hasKids ? '' : ' leaf');
      tw.innerHTML = TOC_TWIST_SVG;
      if (hasKids) {
        li.dataset.hasKids = '1';
        tw.setAttribute('aria-expanded', 'false');
        tw.title = t('reader.tocToggle');
        tw.setAttribute('aria-label', t('reader.tocToggle'));
        tw.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          setTOCOpen(li, !li.classList.contains('open'));
        });
      } else {
        tw.tabIndex = -1;
      }

      const a = document.createElement('a');
      a.textContent = (it.label || '').trim() || t('reader.tocUntitled');
      a.href = '#';
      const pos = tocHrefs.length;
      tocHrefs.push(it.href || '');
      tocLinks.push({ href: it.href || '', a, li });
      // 三角は開閉、文字はジャンプ。子を持つ見出し自体にも飛べる(§9.9)。
      a.addEventListener('click', (e) => {
        e.preventDefault();
        goToTarget(it.href, pos);
        closeTOC();
      });

      row.append(tw, a);
      li.appendChild(row);
      if (hasKids) li.appendChild(render(it.subitems));
      ol.appendChild(li);
    }
    return ol;
  };
  list.innerHTML = '';
  list.appendChild(render(toc));
}

/**
 * 目次から飛ぶ。変換を経た本では spine から外れたファイルを目次が指したまま残ることがあり、
 * そのままだとその項目だけ黙って反応しない。friendly では推測で救済する(§8.13)。
 */
async function goToTarget(href, pos = -1) {
  if (!href) return false;
  // foliate の goTo は「解決できたか」を戻り値で区別しない。resolveHref は
  // spine に載っていない項目に対して index = -1 を返し、レンダラは黙って無視する
  // (= その目次項目だけ反応しない)。index を自分で検査して失敗を見抜く。
  let resolved = null;
  try { resolved = await view.goTo(href); } catch { /* 下の救済へ */ }
  if (resolved && resolved.index >= 0) return true;
  if (pref('renderMode') === 'raw') return false;   // raw は EPUB の指定どおりに壊れて見せる
  const sectionHrefs = (view.book?.sections || []).map((s) => s.id || '');
  const index = ts.guessSectionFor({ href, sectionHrefs, tocHrefs, pos });
  try { await view.renderer.goTo({ index, anchor: 0 }); return true; } catch { return false; }
}

// いま読んでいる章を目次で強調し、その枝を開いておく(§9.9)。
// 開くのは現在章の親だけで、**ほかの枝は閉じない**。読む人が自分で開いた枝を
// 章が変わるたびに閉じてしまうと、目次を触っている最中に一覧が動いて使いにくい。
function syncTOCCurrent(tocItem) {
  if (!tocLinks.length) return;
  const href = tocItem?.href;
  const list = $('#toc-list');
  for (const { href: h, a, li } of tocLinks) {
    const on = !!href && h === href;
    a.classList.toggle('current', on);
    if (!on) continue;
    // 現在章までの親をすべて開く(閉じたままだと強調した行が見えない)
    for (let p = li?.parentElement; p && p !== list; p = p.parentElement) {
      if (p.tagName === 'LI') setTOCOpen(p, true);
    }
    // 自分が子を持つ見出しなら、自分も開いて中身を見せる
    setTOCOpen(li, true);
    a.scrollIntoView?.({ block: 'nearest' });
  }
}

// 章を観測して本単位の綴じ方向を更新する(§8.4)。
// 表紙・前付けは横組みで作られていることが多く、そこで ltr を確定すると
// 縦書き本のページ送りが表紙にいる間だけ逆を向くので、証拠として採らない。
// 本文の走査を伴うので、章の読み込みと位置確定のときだけ呼ぶ(毎ページ送りでは呼ばない)。
function observeSection(doc) {
  const d = doc || view.renderer?.getContents?.()[0]?.doc;
  if (!d?.body) return;
  bookDir = noteSectionDirection(bookDir, {
    forcedBinding: pref('binding'),
    sectionDir: ts.pageDirection(d),
    frontMatter: ts.isFrontOrBackMatter(d),
    evidence: ts.hasDirectionEvidence(d),
  });
}

// ページ送り・進捗スライダーの向き。縦書き=右→左(rtl)、横書き=左→右(ltr)。
// 「章ごとの向き」ではなく**本単位の綴じ方向**で決める(§8.4 の実害の記録を参照)。
function effectiveDir() {
  const wm = pref('writingMode');
  if (wm === 'vertical') return 'rtl';
  if (wm === 'horizontal') return 'ltr';
  if (autoVertical) return 'rtl';           // 壊れた縦書き本を縦へ補正中
  const forced = pref('binding');
  if (forced === 'rtl' || forced === 'ltr') return forced;
  return bookDir.dir;
}

// 綴じ方向を view に反映し、進捗スライダーを鏡像化する。
// RTL(右→左)では Kindle 準拠で 右端=先頭, 左端=末尾。value は fraction(0=先頭)のまま、
// CSS direction:rtl で見た目だけ反転させる。
// view.book.dir は goLeft/goRight(タップ・矢印キー)の左右判定に使われるので、
// 強制縦横のときはそれも合わせて上書きする(横に強制したのに左タップで進む、を防ぐ)。
function applyReadingDirection() {
  const dir = effectiveDir();
  if (view.book) view.book.dir = dir;
  $('#progress').style.direction = dir === 'rtl' ? 'rtl' : 'ltr';
  // トラックの塗りは direction では反転しないので、グラデーションの向きも合わせる。
  $('#progress').style.setProperty('--track-to', dir === 'rtl' ? 'left' : 'right');
}

// ---- 強制縦書き / 強制横書き ----
// 注入CSSで本文の writing-mode を上書きし、foliate に段組みを組み直させる。
// 本を開き直さないので読書位置は保たれる。
function applyWritingMode() {
  applyReaderStyles();                                     // 以降のセクション読み込みにも効く
  try { view.renderer?.refreshDirection?.(); } catch { /* noop */ } // 表示中のページを再レイアウト
  applyReadingDirection();
  updateWritingModeButton();
  // 'auto' へ戻したときに自動縦書き補正を再評価する(次のセクションまで待たせない)。
  // maybeAutoVertical は補正済みなら即 return するので、ここから再入しても一巡で収束する。
  maybeAutoVertical();
}

async function cycleWritingMode() {
  const i = WRITING_MODES.indexOf(pref('writingMode') || 'auto');
  await setPref('writingMode', WRITING_MODES[(i + 1) % WRITING_MODES.length]);
  applyWritingMode();
}

function updateWritingModeButton() {
  const btn = document.getElementById('btn-writing');
  if (!btn) return;
  const mode = WRITING_MODES.includes(pref('writingMode')) ? pref('writingMode') : 'auto';
  btn.dataset.mode = mode;
  // applyTranslations() が後から走っても正しい文言になるよう、キー自体を差し替える
  btn.setAttribute('data-i18n-title', 'reader.writing.' + mode);
  btn.title = t('reader.writing.' + mode);
  // 絵柄は「いま実際に組まれている向き」を出す(Swift も isVertical で出し分けている)。
  const vertical = (renderedDirection()?.vertical) ?? (effectiveWritingMode() === 'vertical');
  const v = btn.querySelector('.ic-wm-v'), h = btn.querySelector('.ic-wm-h');
  if (v && h) { v.style.display = vertical ? '' : 'none'; h.style.display = vertical ? 'none' : ''; }
  // 強制しているときはアクセント色で「本の指定を上書きしている」ことを示す。
  btn.style.color = mode === 'auto' ? '' : 'var(--accent)';
}

/**
 * 左のサイドバーを開く。目次としおりは同じ場所を使う(排他)。
 * 本文に重ねず**横に並べて押しのける**(Swift の NavigationSplitView と同じ)。
 */
function openSide(kind) {
  const side = $('#side');
  side.classList.remove('toc', 'bm');
  side.classList.add(kind);
  $('#side-title').textContent = t(kind === 'toc' ? 'reader.toc' : 'reader.bookmarks');
  $('#toc-list').hidden = kind !== 'toc';
  $('#bm-list').hidden = kind !== 'bm';
  $('#bm-add').hidden = kind !== 'bm';
  updateSideButtons();
}
function closeSide() {
  $('#side').classList.remove('toc', 'bm');
  updateSideButtons();
}
function sideKind() {
  const c = $('#side').classList;
  return c.contains('toc') ? 'toc' : (c.contains('bm') ? 'bm' : null);
}
/** 目次ボタンは開いている間だけサイドバーの絵に変わる(Swift と同じ)。 */
function updateSideButtons() {
  const open = sideKind() === 'toc';
  const b = document.getElementById('btn-toc');
  if (!b) return;
  b.querySelector('.ic-toc-list').style.display = open ? 'none' : '';
  b.querySelector('.ic-toc-side').style.display = open ? '' : 'none';
}

function openTOC() { openSide('toc'); }
function closeTOC() { if (sideKind() === 'toc') closeSide(); }

// ---- M2: しおり ----
async function loadBookmarks() { return (await storeGet('bm-' + safeId())) || []; }
async function saveBookmarks(list) { await storeSet('bm-' + safeId(), list); }

async function addBookmark() {
  if (!lastCfi) return;
  const list = await loadBookmarks();
  if (list.some((b) => b.cfi === lastCfi)) return; // 重複防止
  let excerpt = '';
  try {
    const doc = view.renderer.getContents()[0]?.doc;
    excerpt = (doc?.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  } catch { /* noop */ }
  list.push({ cfi: lastCfi, fraction: lastFraction, excerpt, createdAt: Date.now() });
  await saveBookmarks(list);
  await renderBookmarks();
}

async function renderBookmarks() {
  const box = $('#bm-list');
  const list = await loadBookmarks();
  list.sort((a, b) => (a.fraction || 0) - (b.fraction || 0));
  if (!list.length) { box.innerHTML = `<p style="color:var(--muted);font-size:.85rem;padding:8px">${t('reader.bmEmpty')}</p>`; return; }
  box.innerHTML = '';
  for (const bm of list) {
    const row = document.createElement('div');
    row.className = 'bm-item';
    const date = bm.createdAt ? new Date(bm.createdAt).toLocaleDateString() : '';
    row.innerHTML = `<span class="bm-pct">${Math.round((bm.fraction || 0) * 100)}%</span>
      <span class="bm-go"><div class="bm-ex">${escapeReader(bm.excerpt || '(位置)')}</div>
        <div class="bm-date">${escapeReader(date)}</div></span>
      <button class="bm-del" title="${t('dict.remove')}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button>`;
    row.querySelector('.bm-go').addEventListener('click', () => { view.goTo(bm.cfi).catch(() => {}); closeBM(); });
    row.querySelector('.bm-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const l = (await loadBookmarks()).filter((x) => x.cfi !== bm.cfi);
      await saveBookmarks(l); await renderBookmarks();
    });
    box.appendChild(row);
  }
}
function escapeReader(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function openBM() { await renderBookmarks(); openSide('bm'); }
function closeBM() { if (sideKind() === 'bm') closeSide(); }

// ---- M6: 強制余白モード ----
function applyForcedMargin() {
  $('#reader').classList.toggle('force-margin', !!settings.forceMargin);
}
async function toggleForcedMargin() {
  settings.forceMargin = !settings.forceMargin;
  applyForcedMargin();
  await saveSettings(settings);
}

// ---- L1: 本文検索 ----
// 全文一致が数千件になる語(「の」等)で UI が固まるのを避けるため上限を設ける(§8.14)。
const SEARCH_LIMIT = 500;
let searchAbort = 0;
function openSearch() { $('#search-panel').classList.add('show'); setTimeout(() => $('#search-input').focus(), 50); }
function closeSearch() { $('#search-panel').classList.remove('show'); }

async function runSearch(query) {
  const results = $('#search-results');
  const status = $('#search-status');
  results.innerHTML = '';
  try { view.clearSearch(); } catch { /* noop */ }
  if (!query || query.length < 1) { status.textContent = ''; return; }
  const myRun = ++searchAbort;
  status.textContent = t('reader.searching');
  let count = 0;
  try {
    for await (const r of view.search({ query })) {
      if (myRun !== searchAbort) return; // 新しい検索に置き換わった
      if (r === 'done') break;
      if (count >= SEARCH_LIMIT) break;
      if (r.subitems) {
        for (const sub of r.subitems) {
          if (count >= SEARCH_LIMIT) break;
          count++;
          const ex = sub.excerpt || {};
          const div = document.createElement('div');
          div.className = 'sr-item';
          div.innerHTML = `<span class="sr-label">${escapeReader(r.label || '')}</span>${escapeReader(ex.pre || '')}<b>${escapeReader(ex.match || '')}</b>${escapeReader(ex.post || '')}`;
          div.addEventListener('click', () => { view.goTo(sub.cfi).catch(() => {}); closeSearch(); });
          results.appendChild(div);
        }
      }
    }
    status.textContent = t('reader.searchCount', { n: count })
      + (count >= SEARCH_LIMIT ? ' ' + t('reader.searchTruncated', { n: SEARCH_LIMIT }) : '');
  } catch (e) {
    status.textContent = String(e);
  }
  return count;
}

// ---- L2: カスタムCSS編集(全書籍共通 + 本別, ライブ反映) ----
function openCssEditor() {
  const back = document.createElement('div');
  back.className = 'modal-backdrop show';
  back.innerHTML = `<div class="modal">
    <h2>${t('reader.css')}</h2>
    <p class="desc">${t('reader.cssDesc')}</p>
    <div class="row" style="flex-direction:column;align-items:stretch">
      <label style="margin-bottom:4px">${t('reader.cssCommon')}</label>
      <textarea id="css-common" style="width:100%;height:120px;font-family:monospace;font-size:.82rem"></textarea></div>
    <div class="row" style="flex-direction:column;align-items:stretch">
      <label style="margin-bottom:4px">${t('reader.cssBook')}</label>
      <textarea id="css-book" style="width:100%;height:120px;font-family:monospace;font-size:.82rem"></textarea></div>
    <div class="modal-actions">
      <button id="css-close" class="primary">${t('settings.close')}</button>
    </div></div>`;
  document.body.appendChild(back);
  const common = back.querySelector('#css-common');
  const book = back.querySelector('#css-book');
  common.value = userCSS || '';
  book.value = perBookCSS || '';
  const apply = () => { userCSS = common.value; perBookCSS = book.value; applyReaderStyles(); };
  common.addEventListener('input', apply);
  book.addEventListener('input', apply);
  const close = async () => {
    userCSS = common.value; perBookCSS = book.value;
    await saveUserCSS(userCSS);
    await storeSet('css-' + safeId(), perBookCSS);
    applyReaderStyles();
    back.remove();
  };
  back.querySelector('#css-close').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
}

// ---------------------------------------------------------------------------
// 表示モード・綴じ方向・見開き・判型(§8.1 / §8.4 / §8.7 / §8.9 / §8.10)
// ---------------------------------------------------------------------------
// 本のデータからは決められない値には「押下で巡回」の操作系を与え、本ごとに覚える。

async function cycleRenderMode() {
  await setPref('renderMode', prefs.nextRenderMode(pref('renderMode')));
  // friendly が付けた DOM 変更を戻す/入れ直す → 組み直す
  for (const c of view.renderer?.getContents?.() || []) applyRenderModeToDoc(c.doc);
  applyReaderStyles();
  try { view.renderer?.render?.(); } catch { /* noop */ }
  updateModeButtons();
}

async function cycleBinding() {
  const next = nextBinding(pref('binding'));
  await setPref('binding', next);
  if (next === 'auto') {
    // 自動へ戻すときは判定をやり直す(確定済みの値を引きずらない)
    bookDir = initialBookDir({
      forcedBinding: 'auto',
      writingMode: pref('writingMode'),
      hint: view.book?.metadata?.primaryWritingMode,
      ppd: bookNaturalDir,
    });
    observeSection();
  }
  applyReadingDirection();
  updateModeButtons();
}

async function cycleTextSpread() {
  await setPref('textSpread', prefs.nextSpread(pref('textSpread')));
  applyTextSpread();
  updateModeButtons();
}

async function cycleImageSpread() {
  await setPref('imageSpread', prefs.nextSpread(pref('imageSpread')));
  // 見開きの組は本を開く時点で決まる(fixed-layout.js が spine を舐めてペアを作る)ので、
  // 現在位置を保ったまま開き直す。
  if (view.isFixedLayout) await openBook();
  updateModeButtons();
}

/**
 * 本文の見開き。横書きと縦書きで効かせるところがまったく違う(§8.10)。
 *   横書き: 列数で決まる。portrait 用の変数も一緒に倒して窓の縦横に依らず固定する。
 *   縦書き: 多段組は inline 方向(上下)へ積むので列を増やしても見開きにならない。
 *           1 ページの幅は block 方向で決まるので、本文ブロックの幅そのものを倍にする。
 */
function applyTextSpread() {
  const r = view?.renderer;
  if (!r || view.isFixedLayout) return;
  const mode = pref('textSpread') || 'auto';
  const vertical = (renderedDirection()?.vertical) ?? (effectiveWritingMode() === 'vertical');
  const key = mode + ':' + vertical;
  if (key === lastSpreadKey) return;    // render() をやり直すと組版が全部組み直しになる
  lastSpreadKey = key;
  if (vertical) {
    r.removeAttribute('max-column-count');
    r.removeAttribute('max-column-count-portrait');
    if (mode === 'always') r.setAttribute('max-block-size', '2880px'); // 既定 1440px の 2 倍 = 紙の見開き 1 面
    else r.removeAttribute('max-block-size');
  } else {
    r.removeAttribute('max-block-size');
    if (mode === 'auto') {
      r.removeAttribute('max-column-count');
      r.removeAttribute('max-column-count-portrait');
    } else {
      const n = mode === 'always' ? '2' : '1';
      r.setAttribute('max-column-count', n);
      r.setAttribute('max-column-count-portrait', n);
    }
  }
}
let lastSpreadKey = null;

/**
 * 画像ページの見開き。固定レイアウト(FXL = 漫画・写真集)にだけ効く。
 *   never  … ペアを組まず 1 ページずつ
 *   always … 窓が縦長でも 2 ページ並べる
 *   auto   … 本の rendition:spread の指定に従う
 * ペアの組み立ては本を開く時点で行われるので、open の直前に rendition を差し替える。
 * リフロー本は 1 章 = 1 iframe なので隣り合う画像章を横に並べることはできない
 * (すでに見開きとして 1 枚に描かれている絵は、そのまま 1 面いっぱいに出る)。
 */
function applyImageSpreadToBook(book) {
  if (book?.rendition?.layout !== 'pre-paginated') return;
  const mode = pref('imageSpread') || 'auto';
  if (mode === 'never') book.rendition = { ...book.rendition, spread: 'none' };
  else if (mode === 'always') book.rendition = { ...book.rendition, spread: 'both' };
}

// ---- 強制アスペクト比(§8.9) ----
// 元データの比率がページごとに揃っていない本を揃える。**収めるのではなく引き伸ばす**ので、
// 比率の違う面は歪む——それを承知で揃えたいときの機能。本ごとにしか持たない。
function applyForcedAspect() {
  const r = view?.renderer;
  if (!r) return;
  r.forcedAspect = prefs.parseAspect(bookPrefs.aspect);
  try { r.render?.(); } catch { /* noop */ }
}

/** OPF の rendition:viewport から「この本の判型」を推測する(メニューの候補に出すだけ)。 */
function detectBookAspect() {
  const src = String(view.book?.rendition?.viewport || '');
  const w = /width\s*=\s*(\d+(?:\.\d+)?)/.exec(src)?.[1];
  const h = /height\s*=\s*(\d+(?:\.\d+)?)/.exec(src)?.[1];
  if (w && h) return `${Math.round(+w)}:${Math.round(+h)}`;
  // 無ければ表示中の画像の実寸から拾う
  for (const c of view.renderer?.getContents?.() || []) {
    const el = c.doc?.body?.querySelector('img');
    if (el?.naturalWidth > 0 && el?.naturalHeight > 0) return `${el.naturalWidth}:${el.naturalHeight}`;
  }
  return '';
}

function openAspectMenu() {
  const detected = detectBookAspect();
  const cur = bookPrefs.aspect || '';
  const opts = [...new Set([detected, ...prefs.ASPECT_PRESETS].filter(Boolean))];
  const back = document.createElement('div');
  back.className = 'modal-backdrop show';
  back.innerHTML = `<div class="modal">
    <h2>${t('reader.aspect')}</h2>
    <p class="desc">${t('reader.aspectDesc')}</p>
    <div class="row"><label>${t('reader.aspectRatio')}</label>
      <select id="asp-sel" class="grow">
        <option value="">${t('reader.aspectOff')}</option>
        ${opts.map((o) => `<option value="${o}"${o === cur ? ' selected' : ''}>${o.replace(':', ' : ')}${o === detected ? '（' + t('reader.aspectDetected') + '）' : ''}</option>`).join('')}
      </select></div>
    <div class="row"><label>${t('reader.aspectCustom')}</label>
      <input id="asp-custom" class="grow" placeholder="844:1200" value="${cur && !opts.includes(cur) ? cur : ''}"></div>
    <div class="modal-actions">
      <button id="asp-cancel">${t('common.cancel')}</button>
      <button id="asp-ok" class="primary">${t('common.ok')}</button>
    </div></div>`;
  document.body.appendChild(back);
  const done = () => back.remove();
  back.querySelector('#asp-cancel').addEventListener('click', done);
  back.addEventListener('click', (e) => { if (e.target === back) done(); });
  back.querySelector('#asp-ok').addEventListener('click', async () => {
    const custom = back.querySelector('#asp-custom').value.trim();
    const val = custom || back.querySelector('#asp-sel').value;
    bookPrefs = prefs.setPref(bookPrefs, settings, 'aspect', prefs.aspectToString(prefs.parseAspect(val)));
    await prefs.saveBookPrefs(bookId, bookPrefs);
    applyForcedAspect();
    updateModeButtons();
    done();
  });
}

// ---------------------------------------------------------------------------
// 対訳ペイン(§13)
// ---------------------------------------------------------------------------
// 本文(原文)はそのまま左に残し、訳を右のペインに出す。foliate の列レイアウトへ
// 訳文を割り込ませると、画像ページ・見開き・縦書きの組みと衝突して破綻するため。

const trCache = new tr.TranslationCache((obj) => { saveTranslationCache(obj); });
let trOpen = false;
let trTimer = null;
let trRun = 0;
let trAbort = null;

function trSettings() { return { ...tr.DEFAULT_TRANSLATION, ...(settings.translation || {}) }; }

function toggleTranslate() {
  trOpen = !trOpen;
  $('#tr-pane').classList.toggle('show', trOpen);
  updateModeButtons();
  if (trOpen) refreshTranslation();
  else { trAbort?.abort(); trCache.flush(); }
}

// ページ送りのたびに 400ms のデバウンスをかけて取り直す(連打で毎回 LLM を叩かない)。
function scheduleTranslate() {
  if (!trOpen) return;
  clearTimeout(trTimer);
  trTimer = setTimeout(() => refreshTranslation(), tr.REFRESH_DEBOUNCE_MS);
}

async function refreshTranslation(force = false) {
  const body = $('#tr-body');
  const status = $('#tr-status');
  const myRun = ++trRun;
  trAbort?.abort();
  trAbort = new AbortController();
  const signal = trAbort.signal;

  const c = view.renderer?.getContents?.()[0];
  const { passages, reason } = tr.extractPassages(c?.doc, view.lastLocation?.range);
  if (!passages.length) {
    body.innerHTML = '';
    status.textContent = reason === 'image-page' ? t('reader.trImagePage') : t('reader.trNoText');
    return;
  }

  // 行の枠を先に作り、終わった行から順に埋める(全部揃うまで待たせない)
  body.innerHTML = '';
  const rows = passages.map((p) => {
    const div = document.createElement('div');
    div.className = 'tr-item';
    div.innerHTML = `<div class="tr-src"></div><div class="tr-dst pending">${t('reader.trQueued')}</div>`;
    div.querySelector('.tr-src').textContent = p.text;
    div.addEventListener('dblclick', () => flashPassage(p.el));
    body.appendChild(div);
    return div;
  });
  let done = 0;
  const cfg = trSettings();
  status.textContent = t('reader.trProgress', { i: 0, n: passages.length, model: cfg.model || '…' });

  try {
    const res = await tr.translatePassages(passages, {
      settings: cfg, cache: trCache, force, signal,
      onRow: (i, st) => {
        if (myRun !== trRun) return;
        const dst = rows[i]?.querySelector('.tr-dst');
        if (!dst) return;
        dst.classList.remove('pending', 'error');
        if (st.state === 'running') { dst.classList.add('pending'); dst.textContent = t('reader.trRunning'); return; }
        if (st.state === 'error') {
          dst.classList.add('error');
          const known = { THINKING_ONLY: 'reader.trThinkingOnly', EMPTY_COMPLETION: 'reader.trEmpty' }[st.error];
          dst.textContent = known ? t(known) : st.error;
          done++;
          return;
        }
        dst.textContent = st.text;
        done++;
        status.textContent = t('reader.trProgress', { i: done, n: passages.length, model: cfg.model || '' });
      },
    });
    if (myRun !== trRun) return;
    status.textContent = t('reader.trProgress', { i: done, n: passages.length, model: res.model });
  } catch (e) {
    if (myRun !== trRun) return;
    status.textContent = e?.code === 'NO_MODEL' ? t('reader.trNoModel') : String(e?.message || e);
  }
}

function rangeOf(el) {
  const r = el.ownerDocument.createRange();
  r.selectNodeContents(el);
  return r;
}

// [feat:tr-flash][trans] 対訳の行をダブルクリックして本文の段落を光らせる
// 対訳の行をダブルクリックしたとき、本文の該当段落を数秒だけ光らせる。
//
// **飛ばさない理由**: 対訳ペインに並ぶ行は「いま画面に見えている範囲」と重なる段落だけで
// 作っている(translate.js の extractPassages に view.lastLocation.range を渡している)。
// だから goTo で飛ばしても行き先はもう画面に出ており、見た目には何も起きなかった。
// 読む人が知りたいのは「この訳は本文のどこか」なので、光らせて場所を示す。
let trFlashTimer = 0;
function flashPassage(el) {
  try {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const range = rangeOf(el);
    // 縦書きの多段組では段の外に居ることがあるので、まず見える所へ寄せる
    try { view.renderer?.scrollToAnchor?.(range, true); } catch { /* noop */ }
    if (!win?.CSS?.highlights || !win.Highlight) return;
    if (!doc.__trStyled) {
      const style = doc.createElement('style');
      // 読み上げの黄色と混ざらないよう、朱色寄りの色にする
      style.textContent = '::highlight(tr-hit){background-color: rgba(230,90,65,.28); color: inherit;}';
      (doc.head || doc.documentElement).appendChild(style);
      doc.__trStyled = true;
    }
    win.CSS.highlights.set('tr-hit', new win.Highlight(range.cloneRange()));
    clearTimeout(trFlashTimer);
    trFlashTimer = setTimeout(() => {
      try { win.CSS.highlights.delete('tr-hit'); } catch { /* noop */ }
    }, 1800);
  } catch { /* 光らせられなくても対訳は使える */ }
}

/** いま本文に出ている「対訳の行を光らせた印」を消す。ページを移ったときに呼ぶ。 */
function clearPassageFlash() {
  clearTimeout(trFlashTimer);
  for (const c of view?.renderer?.getContents?.() || []) {
    try { c.doc?.defaultView?.CSS?.highlights?.delete('tr-hit'); } catch { /* noop */ }
  }
}

function wireTranslatePane() {
  const pane = $('#tr-pane');
  document.getElementById('btn-translate')?.addEventListener('click', toggleTranslate);
  $('#tr-close').addEventListener('click', toggleTranslate);
  $('#tr-refresh').addEventListener('click', () => refreshTranslation(true));
  $('#tr-src-toggle').addEventListener('click', () => pane.classList.toggle('hide-src'));
  let scale = 1;
  const setScale = (d) => {
    scale = Math.min(2, Math.max(0.7, Math.round((scale + d) * 10) / 10));
    pane.style.setProperty('--tr-scale', scale);
  };
  $('#tr-font-dec').addEventListener('click', () => setScale(-0.1));
  $('#tr-font-inc').addEventListener('click', () => setScale(+0.1));
  // ハンドルのドラッグで幅を変える(右側にあるので左へ引くほど広くなる)
  const handle = $('#tr-handle');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const w = Math.min(900, Math.max(280, window.innerWidth - ev.clientX));
      pane.style.width = w + 'px';
      pane.classList.toggle('narrow', w < 520);
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

// ---------------------------------------------------------------------------
// 本文の右クリック → 選択語を読み上げ辞書へ登録(§9.7)
// ---------------------------------------------------------------------------
function onContentContextMenu(e) {
  const sel = e.target?.ownerDocument?.defaultView?.getSelection?.();
  const text = sel && !sel.isCollapsed ? String(sel).trim() : '';
  if (!text) return;                 // 選択が空のときは既定のメニューに任せる
  e.preventDefault();
  openDict(() => settings, { addSurface: text.slice(0, 40), onClose: refreshDict });
}

function onTTSState({ playing, paused }) {
  const btn = $('#tts-play');
  btn.classList.toggle('active', playing && !paused);
  // アイコンは HTML 内の SVG 2 枚(.ic-play/.ic-pause)を class で切替(絵文字は使わない)
  btn.classList.toggle('playing', playing && !paused);
  // 書き出しは読み上げと同じ合成経路を使うので、再生中はメニューを淡色に落とす。
  if (autoPager) void syncMenuState();
}

/**
 * 読み上げが利用者に伝えるべき失敗をしたとき。
 * いまは「エンジンに届かない」だけ——VOICEVOX / AivisSpeech は別途入れてもらう必要があり、
 * 入れていない人が黙って無音を見せられるのを防ぐ(tts.js の ENGINE_FAILURE_LIMIT)。
 */
function onTTSError(code) {
  // persist にはしない——読み上げは既に止めてあるので、もう一度押せばまた出る。
  // 出しっぱなしにすると、エンジンを起動して読み始めた後まで警告が残る。
  if (code === 'ENGINE_UNREACHABLE') toast(t('tts.engineUnreachable'));
}

async function startTTS() {
  if (tts.playing && !tts.paused) { tts.pause(); return; }
  if (tts.playing && tts.paused) { tts.resume(); return; }
  tts.play(await refreshDict());
}

// 画面下部に一時的な状態表示(合成の進捗・完了・エラー)。
let toastEl = null, toastTimer = null;
function toast(msg, { persist = false } = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'tts-toast';
    // 下バーは2段(約96px)なので、その上に出す。
    toastEl.style.cssText = 'position:fixed;left:50%;bottom:112px;transform:translateX(-50%);z-index:50;'
      + 'background:var(--toolbar,#222);color:var(--fg,#eee);padding:8px 14px;border-radius:8px;'
      + 'font-size:.85rem;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:80vw;white-space:nowrap;'
      + 'overflow:hidden;text-overflow:ellipsis';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.display = '';
  // 下バー右端の状態表示にも同じ文言を出す(元アプリはここが本来の置き場所)。
  const st = $('#tts-status');
  if (st) st.textContent = msg;
  clearTimeout(toastTimer);
  if (!persist) toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.display = 'none';
    if (st) st.textContent = '';
  }, 4000);
}

// ファイル名の素: 「タイトル_章番号」。
function sectionFilenameBase() {
  const title = ($('#book-title')?.textContent || 'audiobook').trim() || 'audiobook';
  const idx = view.renderer?.getContents?.()[0]?.index ?? 0;
  return `${title}_${String(idx + 1).padStart(3, '0')}`;
}

// 保存先を決める。設定に既定フォルダがあればそこへ自動命名で保存(パネルなし=一発保存)。
// 未設定なら macOS 標準の保存パネル(NSSavePanel)を出し、選んだ親フォルダを既定として記憶する。
// 戻り値: { path } (フルパス指定) | { dir, name } (フォルダ+名) | null (キャンセル)。
async function resolveSaveTarget(filenameBase, ext) {
  const safeName = String(filenameBase).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) + '.' + ext;
  if (settings.ttsSaveDir) return { dir: settings.ttsSaveDir, name: safeName };
  const chosen = await api.saveFileDialog(safeName, ext);
  if (!chosen) return null; // キャンセル
  const dir = chosen.replace(/[\\/][^\\/]*$/, '');
  if (dir && dir !== chosen) { settings.ttsSaveDir = dir; await saveSettings(settings); }
  return { path: chosen };
}
async function writeToTarget(target, b64) {
  return target.path ? api.writeBytes(target.path, b64) : api.saveBytes(target.dir, target.name, b64);
}

// 現在の章(セクション)を音声ファイル(WAV)に保存。
async function saveSectionAudio() {
  const btn = $('#tts-save');
  if (btn.classList.contains('busy')) return;
  const target = await resolveSaveTarget(sectionFilenameBase(), 'wav');
  if (!target) return; // キャンセル
  btn.classList.add('busy');
  exporting = true;
  void syncMenuState();
  try {
    const b64 = await tts.makeSectionWavB64({
      onProgress: (i, n) => toast(t('reader.saveAudioSynth', { i, n }), { persist: true }),
    });
    const path = await writeToTarget(target, b64);
    toast(t('reader.saveAudioDone', { path }));
  } catch (e) {
    if (e?.code === 'EMPTY') toast(t('reader.saveAudioEmpty'));
    else toast(t('reader.saveAudioFail', { err: String(e?.message || e) }));
  } finally {
    btn.classList.remove('busy');
    exporting = false;
    void syncMenuState();
  }
}

// 現在の本文が縦書き(vertical-*)かどうかを判定する。
function currentOrientation() {
  const d = renderedDirection();
  if (d) return d.vertical ? 'vertical' : 'horizontal';
  return view.book?.dir === 'rtl' ? 'vertical' : 'horizontal';
}

// 現在の章を「朗読動画(MP4)」として書き出す。合成→録画(実時間)→保存。
async function saveSectionVideo() {
  const btn = $('#tts-save-video');
  if (btn.classList.contains('busy')) return;
  // 保存先を先に決める(録画してから聞くと数十秒待たせてしまうため)
  const target = await resolveSaveTarget(sectionFilenameBase(), preferredVideoExt());
  if (!target) return; // キャンセル
  btn.classList.add('busy');
  exporting = true;
  void syncMenuState();
  tts?.stop();

  // 進捗つきオーバーレイ(録画中の映像をそのまま見せる)
  const ov = document.createElement('div');
  ov.id = 'video-overlay';
  ov.innerHTML = `<div class="vo-inner">
      <canvas id="vo-canvas"></canvas>
      <div class="vo-bar"><div id="vo-fill"></div></div>
      <div class="vo-row"><span id="vo-status"></span><button id="vo-cancel">${t('reader.cancel')}</button></div>
    </div>`;
  document.body.appendChild(ov);
  const canvas = ov.querySelector('#vo-canvas');
  const fill = ov.querySelector('#vo-fill');
  const status = ov.querySelector('#vo-status');
  const controller = new AbortController();
  ov.querySelector('#vo-cancel').addEventListener('click', () => controller.abort());

  try {
    status.textContent = t('reader.saveAudioSynth', { i: 0, n: '…' });
    const segments = await tts.synthSection({
      onProgress: (i, n) => { status.textContent = t('reader.saveAudioSynth', { i, n }); },
    });
    if (controller.signal.aborted) throw Object.assign(new Error('ABORTED'), { code: 'ABORTED' });
    const theme = videoTheme(settings);
    const { b64 } = await renderSectionVideo(canvas, segments, theme, {
      monitor: true,
      orientation: currentOrientation(),
      signal: controller.signal,
      onProgress: (el, total) => {
        const pct = Math.round((el / total) * 100);
        fill.style.width = pct + '%';
        status.textContent = t('reader.videoRendering', { pct });
      },
    });
    const path = await writeToTarget(target, b64);
    toast(t('reader.saveAudioDone', { path }));
  } catch (e) {
    if (e?.code === 'ABORTED') toast(t('reader.videoCanceled'));
    else if (e?.code === 'EMPTY') toast(t('reader.saveAudioEmpty'));
    else toast(t('reader.saveAudioFail', { err: String(e?.message || e) }));
  } finally {
    ov.remove();
    btn.classList.remove('busy');
    exporting = false;
    void syncMenuState();
  }
}

// ---------------------------------------------------------------------------
// 自動ページ送り / スリープタイマー
// ---------------------------------------------------------------------------

let autoPager = null;
let sleepTimer = null;
/** 書棚の一覧。メニューの「ファイル > 書棚を切り替える」へ写すために持っておく。 */
let profileIndex = { profiles: [], currentID: '' };

/**
 * 下バーのタイマーボタンに稼働状況を出す。
 * 残り時間の枠は停止中も確保しておく——出たり消えたりで幅が変わると隣のボタンまで動く。
 */
function updateTimerStatus() {
  const pager = document.getElementById('btn-pager');
  if (pager) {
    const on = !!autoPager?.isRunning;
    pager.classList.toggle('on', on);
    pager.querySelector('.fwd-fill').style.display = on ? '' : 'none';
    pager.querySelector('.fwd-line').style.display = on ? 'none' : '';
    $('#pager-left').textContent = on ? (autoPager.isHolding ? '—' : autoPager.remainingText) : '';
  }
  const sleep = document.getElementById('btn-sleep');
  if (sleep) {
    const on = !!sleepTimer?.isActive;
    sleep.classList.toggle('on', on);
    sleep.querySelector('.moon').setAttribute('fill', on ? 'currentColor' : 'none');
    $('#sleep-left').textContent = sleepTimer?.shutdownCountdown != null
      ? String(Math.round(sleepTimer.shutdownCountdown))
      : (on ? sleepTimer.remainingText : '');
  }
}

function setupTimers() {
  autoPager = new AutoPager({
    // 送る相手は毎回引き直す(本を開き直すと view が入れ替わる)。
    target: () => (view ? {
      isSpeaking: () => !!tts?.playing,
      progression: () => lastFraction,
      advance: async () => { await view.next(); },
      note: () => toast(t('pager.end')),
    } : null),
    seconds: settings.autoPagerSeconds || 30,
    onSecondsChange: async (s) => { settings.autoPagerSeconds = s; await saveSettings(settings); },
    onChange: () => { updateTimerStatus(); },
  });

  // 書棚へ戻ってもタイマーは走り続ける(締め切りを引き継ぐ)。timers.js を参照。
  sleepTimer = createSharedSleepTimer({
    action: settings.sleepTimerAction || 'stopOnly',
    minutes: settings.sleepTimerMinutes || 30,
    // 満了時は必ず読み上げを止める(タイマーの本体)。スリープ・シャットダウンはその後の追加動作。
    onExpire: () => { tts?.stop(); toast(t('sleep.expired')); },
    power: systemPower(api),
    onActionChange: async (a) => { settings.sleepTimerAction = a; await saveSettings(settings); },
    onMinutesChange: async (m) => { settings.sleepTimerMinutes = m; await saveSettings(settings); },
    onChange: () => { updateTimerStatus(); },
  });
}

function startAutoPager(seconds) {
  const s = autoPager.start(seconds);
  toast(t('pager.started', { n: s }));
  void syncMenuState();
}

function stopAutoPager() {
  if (autoPager.stop()) toast(t('pager.stopped'));
  void syncMenuState();
}

function startSleepTimer(minutes) {
  sleepTimer.start(minutes);
  toast(t('sleep.started', { t: sleepTimer.remainingText }));
  void syncMenuState();
}

function cancelSleepTimer() {
  sleepTimer.cancel();
  toast(t('sleep.canceled'));
  void syncMenuState();
}

// (promptNumber は書棚とも共有するので ui-modals.js にある)

// ---------------------------------------------------------------------------
// ネイティブメニューへ写す「いま効いている値」
// ---------------------------------------------------------------------------

/**
 * メニューのチェックマーク・有効無効の材料。
 * 本を開いているときは**その本に効いている値**を出す(pref() は本ごとの上書き → 全体既定)。
 */
function menuState() {
  return {
    theme: settings.theme || 'auto',
    renderMode: pref('renderMode') || 'friendly',
    writingMode: pref('writingMode') || 'auto',
    binding: pref('binding') || 'auto',
    imageSpread: pref('imageSpread') || 'auto',
    textSpread: pref('textSpread') || 'auto',
    autoPagerRunning: !!autoPager?.isRunning,
    autoPagerSeconds: autoPager?.seconds ?? (settings.autoPagerSeconds || 30),
    sleepTimerRunning: !!sleepTimer?.isActive,
    sleepTimerMinutes: sleepTimer?.lastMinutes ?? (settings.sleepTimerMinutes || 30),
    sleepTimerAction: sleepTimer?.action ?? (settings.sleepTimerAction || 'stopOnly'),
    // 音声・動画は同じ合成経路を使うので同時には走らせない。読み上げ中も同様。
    canExport: !!view && !exporting && !tts?.playing,
    // 読んでいる途中でも書棚を切り替えられるようにする(渡さないと一覧が空になる)。
    profiles: profileIndex.profiles.map((p) => ({ id: p.id, name: p.name })),
    currentProfile: profileIndex.currentID,
  };
}

let exporting = false;

async function syncMenuState() {
  await refreshMenu('reader', settings.lang, menuState());
}

/** ポップアップメニュー(SwiftUI の Menu)。ツールバーの「ぁあ」やタイマーの選択に使う。 */
function openPopup(anchor, items) {
  const menu = $('#ctxmenu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { const d = document.createElement('div'); d.className = 'sep'; menu.appendChild(d); continue; }
    if (it.head) { const h = document.createElement('div'); h.className = 'head'; h.textContent = it.head; menu.appendChild(h); continue; }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', async () => { closePopup(); await it.run(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  // ボタンの下に出す。下端に近いときは上へ返す(下バーのボタンは画面の底にある)。
  const below = r.bottom + 4;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  menu.style.top = (below + h > window.innerHeight - 8 ? r.top - h - 4 : below) + 'px';
}
function closePopup() { const m = document.getElementById('ctxmenu'); if (m) m.hidden = true; }

/** ツールバーの「ぁあ」。文字サイズ・配色・カスタムCSS・音声保存(Swift と同じ並び)。 */
function openTextMenu(anchor) {
  const theme = settings.theme;
  openPopup(anchor, [
    { head: t('settings.fontSize') },
    { label: t('reader.textBigger'), run: () => changeFont(+0.1) },
    { label: t('reader.textSmaller'), run: () => changeFont(-0.1) },
    '-',
    { head: t('settings.theme') },
    ...['light', 'sepia', 'dark'].map((k) => ({
      label: (theme === k ? '✓ ' : '　') + t('settings.theme.' + k),
      run: () => setTheme(k),
    })),
    '-',
    { label: t('reader.css'), run: openCssEditor },
    '-',
    { label: t('reader.saveAudio'), run: saveSectionAudio },
  ]);
}

/** 自動ページ送りのメニュー(下バーのボタン)。 */
function openPagerMenu(anchor) {
  const items = [];
  if (autoPager.isRunning) {
    items.push({ label: autoPager.isHolding ? t('pager.holding') : t('pager.remaining', { n: autoPager.remainingText }), disabled: true });
    items.push({ label: t('pager.stop'), run: stopAutoPager });
    items.push('-');
  }
  for (const sec of PRESET_SECONDS) {
    items.push({ label: t('pager.everySeconds', { n: sec }), run: () => startAutoPager(sec) });
  }
  items.push({ label: t('menu.go.autoPagerCustom'), run: async () => {
    const n = await promptNumber({ title: t('pager.title'), label: t('pager.interval'),
      value: autoPager.seconds, min: 1, max: 3600, presets: PRESET_SECONDS });
    if (n != null) startAutoPager(n);
  } });
  openPopup(anchor, items);
}

/** スリープタイマーのメニュー(下バーのボタン)。 */
function openSleepMenu(anchor) {
  const items = [];
  if (sleepTimer.isActive) {
    items.push({ label: t('sleep.left', { t: sleepTimer.remainingText }), disabled: true });
    items.push({ label: t('menu.tts.sleepCancel'), run: cancelSleepTimer });
    items.push('-');
  }
  for (const m of PRESET_MINUTES) {
    items.push({ label: t('sleep.afterMinutes', { n: m }), run: () => startSleepTimer(m) });
  }
  items.push({ label: t('menu.tts.sleepCustom'), run: async () => {
    const n = await promptNumber({ title: t('sleep.title'), label: t('sleep.minutes'),
      value: sleepTimer.lastMinutes, min: 1, max: 720, presets: PRESET_MINUTES });
    if (n != null) startSleepTimer(n);
  } });
  items.push('-');
  items.push({ head: t('sleep.action') });
  for (const a of ['stopOnly', 'sleepSystem', 'shutdown']) {
    items.push({
      label: (sleepTimer.action === a ? '✓ ' : '　') + t('menu.tts.sleep' + a[0].toUpperCase() + a.slice(1)),
      run: () => { sleepTimer.setAction(a); void syncMenuState(); },
    });
  }
  openPopup(anchor, items);
}

/** 設定シート。保存されたら本文へ即反映する(組み直しが要るものは個別の経路で当てる)。 */
function openReaderSettings() {
  openSettings(settings, async (s) => {
    settings = s;
    await loadLocale(s.lang); applyTranslations();
    applyWritingMode();
    for (const c of view.renderer?.getContents?.() || []) applyRenderModeToDoc(c.doc);
    applyReaderStyles();
    lastSpreadKey = null;
    applyTextSpread();
    applyForcedAspect();
    applyReadingDirection();
    updateModeButtons();
    if (trOpen) refreshTranslation(true);   // 前のモデルの訳が混ざらないよう作り直す
    await syncMenuState();                  // 言語が変わったらネイティブメニューも組み直す
  }, {
    // 設定側でキャッシュを捨てたら、こちらが握っている分も捨てる。
    // 残したままだと、書き戻しのデバウンスで消したはずの訳が戻ってくる。
    onCacheCleared: () => { trCache.clear(); if (trOpen) refreshTranslation(true); },
  });
}

/** 要素があるときだけ配線する(ツールバーに出していない操作はメニューバーが持つ)。 */
function on(id, ev, fn) {
  document.getElementById(id)?.addEventListener(ev, fn);
}

function wireControls() {
  on('btn-back', 'click', () => { void backToShelf(); });
  on('btn-toc', 'click', () => { sideKind() === 'toc' ? closeSide() : openTOC(); });
  on('side-close', 'click', closeSide);
  on('bm-add', 'click', addBookmark);
  on('btn-bookmark-add', 'click', addBookmark);
  on('btn-search', 'click', () => {
    $('#search-panel').classList.contains('show') ? closeSearch() : openSearch();
  });
  on('search-close', 'click', closeSearch);
  let searchTimer = null;
  on('search-input', 'input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => runSearch(q), 300);
  });
  on('btn-spread', 'click', toggleSpreadShift);
  on('btn-writing', 'click', cycleWritingMode);
  on('btn-text', 'click', (e) => { e.stopPropagation(); openTextMenu(e.currentTarget); });
  on('btn-pager', 'click', (e) => { e.stopPropagation(); openPagerMenu(e.currentTarget); });
  on('btn-sleep', 'click', (e) => { e.stopPropagation(); openSleepMenu(e.currentTarget); });
  // ツールバーから外した操作(表示モード・綴じ方向・見開き・比率・余白・CSS)は
  // メニューバーの「表示」が持つ。ボタンがある構成でも動くよう配線だけは残す。
  on('btn-css', 'click', openCssEditor);
  on('btn-margin', 'click', toggleForcedMargin);
  on('btn-render', 'click', cycleRenderMode);
  on('btn-binding', 'click', cycleBinding);
  on('btn-imgspread', 'click', cycleImageSpread);
  on('btn-textspread', 'click', cycleTextSpread);
  on('btn-aspect', 'click', openAspectMenu);
  on('btn-bookmarks', 'click', () => { sideKind() === 'bm' ? closeSide() : openBM(); });
  on('font-dec', 'click', () => changeFont(-0.1));
  on('font-inc', 'click', () => changeFont(+0.1));
  wireTranslatePane();
  // ポップアップは画面のどこかを押したら閉じる(macOS の作法)
  document.addEventListener('click', closePopup);
  // 自分で送った直後にすぐ自動送りが来ると 2 ページ飛ぶので、手動操作では間隔を数え直す。
  on('tap-left', 'click', () => { autoPager?.noteManualTurn(); view.goLeft(); });
  on('tap-right', 'click', () => { autoPager?.noteManualTurn(); view.goRight(); });
  on('progress', 'input', (e) => {
    e.target.style.setProperty('--track-p', e.target.value);
    autoPager?.noteManualTurn();
    view.goToFraction(parseFloat(e.target.value));
  });
  on('tts-play', 'click', startTTS);
  on('tts-stop', 'click', () => tts?.stop());
  on('tts-save', 'click', saveSectionAudio);
  on('tts-save-video', 'click', saveSectionVideo);
  on('btn-settings2', 'click', openReaderSettings);

  on('btn-dict2', 'click', () => openDict(() => settings, { onClose: refreshDict }));
  setupAutoHideBars();

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (/^Arrow/.test(e.key)) autoPager?.noteManualTurn();
    if (e.key === 'ArrowLeft') view.goLeft();
    else if (e.key === 'ArrowRight') view.goRight();
    else if (e.key === 'ArrowDown') view.next();
    else if (e.key === 'ArrowUp') view.prev();
    else if (e.key === ' ') { e.preventDefault(); startTTS(); }
    else if (e.key === 'Enter') { e.preventDefault(); tts?.stop(); }
    else if (e.key === 'Escape') {
      // 読み上げ中なら停止、そうでなければ開いているパネルを畳む
      if (tts?.playing) tts.stop();
      else { closeTOC(); closeBM(); closeSearch(); }
    } else if ((e.key === '+' || e.key === ';')) changeFont(+0.1);
    else if (e.key === '-') changeFont(-0.1);
  });
}

/**
 * 本を閉じて書棚へ戻る。読み上げ・自動送りを降ろし、溜めてある保存を書き切ってから離れる。
 * `intent` を渡すと、書棚の画面が開いたところでその操作(書棚の管理・新規書棚)を続ける。
 */
// [feat:reader-drop][reader] 本を読んでいる最中でもウィンドウに本を落として取り込む
/**
 * 読んでいる最中に落とされた本を受け取る。
 *
 * **取り込みそのものはここでしない。** フォルダの展開・進捗の帯・失敗の記録は
 * 書棚の画面が全部持っているので、同じ処理を 2 か所に書かずに、パスを預けて書棚へ渡す。
 * 落とされたのが 1 冊だけなら、書棚が取り込んだあとそのまま開き直す（shelf.js を参照）。
 */
function enableReaderFileDrop() {
  enableFileDrop(async (paths) => {
    if (!paths.length) return;
    toast(t('reader.dropReceived'));
    sessionStorage.setItem('shelf-import', JSON.stringify(paths));
    await backToShelf();
  });
}

async function backToShelf(intent = null) {
  tts?.stop();
  autoPager?.stop();   // ページ送りは本が無いと意味がないので、ここで畳む
  // スリープタイマーは**畳まない**。書棚へ戻っても走り続け、向こうで解除できる
  // (締め切りは sessionStorage 経由で引き継がれる。timers.js を参照)。
  await flushLibrary();
  if (intent) sessionStorage.setItem('shelf-intent', intent);
  location.href = 'index.html';
}

/**
 * 読んでいる途中で書棚を切り替える。
 * 開いている本は**前の書棚のもの**なので、切り替えたら必ず本を閉じて書棚へ戻る。
 */
async function switchToProfile(id) {
  const index = await loadProfiles();
  if (id === index.currentID) return;
  const name = index.profiles.find((p) => p.id === id)?.name || '';
  profileIndex = { ...index, currentID: id };
  tts?.stop();
  autoPager?.stop();
  await flushLibrary();
  await switchProfile(index, id);
  sessionStorage.setItem('shelf-intent', 'switched:' + name);
  location.href = 'index.html';
}

// ネイティブメニュー(リーダー文脈)。処理は画面内ボタンと同じものを呼ぶだけにして二重管理を避ける。
async function wireMenu() {
  await setupMenu('reader', {
    'app.settings': openReaderSettings,
    'file.saveAudio': saveSectionAudio,
    'file.saveVideo': saveSectionVideo,
    'edit.find': openSearch,
    'view.toc': () => { sideKind() === 'toc' ? closeSide() : openTOC(); },
    'view.translate': toggleTranslate,
    'view.bookmarks': () => { sideKind() === 'bm' ? closeSide() : openBM(); },
    'view.bookmarkAdd': addBookmark,
    'view.margin': toggleForcedMargin,
    'view.spread': toggleSpreadShift,
    'view.css': openCssEditor,
    'view.aspect': openAspectMenu,
    // 文字サイズ・行間(全書籍共通の設定を書き換える)
    'view.fontInc': () => changeFont(+0.1),
    'view.fontDec': () => changeFont(-0.1),
    'view.fontReset': () => setFont(1.0),
    'view.lineInc': () => changeLineHeight(+0.1),
    'view.lineDec': () => changeLineHeight(-0.1),
    'view.lineReset': () => setLineHeight(1.8),
    // 選択式(押した値をそのまま入れる。巡回ではないので id の末尾を引数に取る)
    'view.theme.': (v) => setTheme(v),
    'view.render.': (v) => setDisplayPref('renderMode', v),
    'view.writing.': (v) => setDisplayPref('writingMode', v),
    'view.binding.': (v) => setDisplayPref('binding', v),
    'view.imageSpread.': (v) => setDisplayPref('imageSpread', v),
    'view.textSpread.': (v) => setDisplayPref('textSpread', v),
    // ページ送りは論理的な向き(次/前)。左右の意味は綴じ方向で反転するので view に任せる。
    'go.next': () => { autoPager?.noteManualTurn(); return view?.next(); },
    'go.prev': () => { autoPager?.noteManualTurn(); return view?.prev(); },
    'go.shelf': backToShelf,
    // 書棚まわりは書棚の画面が持っているので、本を閉じて戻ってから開く。
    'file.profiles': () => backToShelf('manage'),
    'file.newProfile': () => backToShelf('new'),
    'file.profile.': switchToProfile,
    'go.autoPager.custom': async () => {
      const n = await promptNumber({
        title: t('pager.title'), label: t('pager.interval'),
        value: autoPager.seconds, min: 1, max: 3600, presets: PRESET_SECONDS,
      });
      if (n != null) startAutoPager(n);
    },
    'go.autoPager.stop': stopAutoPager,
    'go.autoPager.': (v) => startAutoPager(Number(v)),
    'tts.play': startTTS,
    'tts.stop': () => tts?.stop(),
    'tts.dict': () => openDict(() => settings, { onClose: refreshDict }),
    'tts.sleep.custom': async () => {
      const n = await promptNumber({
        title: t('sleep.title'), label: t('sleep.minutes'),
        value: sleepTimer.lastMinutes, min: 1, max: 720, presets: PRESET_MINUTES,
      });
      if (n != null) startSleepTimer(n);
    },
    'tts.sleep.cancel': cancelSleepTimer,
    'tts.sleep.action.': (v) => { sleepTimer.setAction(v); void syncMenuState(); },
    'tts.sleep.': (v) => startSleepTimer(Number(v)),
  }, settings.lang, menuState());
}

// S1: 文字サイズ変更(0.6〜2.5 にクランプ, 永続化, 即反映)
async function changeFont(delta) {
  await setFont((settings.fontScale || 1) + delta);
}
async function setFont(value) {
  settings.fontScale = Math.min(2.5, Math.max(0.6, Math.round(value * 10) / 10));
  applyReaderStyles();
  await saveSettings(settings);
}

// S2: 行間(1.0〜2.4)。文字サイズと同じ注入経路。
async function changeLineHeight(delta) {
  await setLineHeight((settings.lineHeight || 1.8) + delta);
}
async function setLineHeight(value) {
  settings.lineHeight = Math.min(2.4, Math.max(1.0, Math.round(value * 10) / 10));
  applyReaderStyles();
  await saveSettings(settings);
}

/** テーマ(全書籍共通)。本文・リーダー画面・UI の三か所へ同時に効かせる。 */
async function setTheme(theme) {
  settings.theme = theme;
  applyTheme(theme);
  applyReaderStyles();
  await saveSettings(settings);
  await syncMenuState();
}

/**
 * 選択式の表示指定(表示モード・書字方向・綴じ方向・見開き)を**この本の指定**として入れる。
 * 既定と同値なら本ごとの指定を持たない(§15.3)のは setPref が面倒を見る。
 * 巡回ボタン(cycle*)と同じ後処理を通すため、値を決めてから同じ経路へ流す。
 */
async function setDisplayPref(key, value) {
  if (pref(key) === value) { await syncMenuState(); return; }
  await setPref(key, value);
  if (key === 'renderMode') {
    for (const c of view.renderer?.getContents?.() || []) applyRenderModeToDoc(c.doc);
    applyReaderStyles();
    lastSpreadKey = null;
    applyTextSpread();
  } else if (key === 'writingMode') {
    applyWritingMode();
  } else if (key === 'binding') {
    bookDir = initialBookDir({
      forcedBinding: pref('binding'), writingMode: pref('writingMode'),
      hint: view?.book?.metadata?.primaryWritingMode, ppd: bookNaturalDir,
    });
    applyReadingDirection();
  } else if (key === 'textSpread') {
    lastSpreadKey = null;
    applyTextSpread();
  } else if (key === 'imageSpread') {
    await openBook();   // 見開きの組み方は open のときに決まるので開き直す
  }
  updateModeButtons();
  await syncMenuState();
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center">読み込みに失敗しました<br><small>${e}</small></div>`);
});

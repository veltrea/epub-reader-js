// 読み上げ制御。
// - 文分割/ハイライト/章内の走査は foliate-js の TTS(view.initTTS)を再利用。
// - 音声だけ VOICEVOX/AivisSpeech に差し替える(SSML から文テキストを取り出して各文を合成)。
// - 現在文は本文の上に矩形を重ねて強調し、foliate の scrollToAnchor で追従。
import * as api from './api.js';
import { engineBaseUrl } from './store.js';
import { prepare as prepareReading } from './dictionary.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 連続でこの回数だけ合成に失敗したら、エンジンに届いていないとみなして読み上げを止める。
 * VOICEVOX / AivisSpeech は別途インストールが要るので、**入れていない人は必ずここを通る**。
 * 黙って飛ばし続けると「再生中の表示のまま、ハイライトだけが進んで無音」になる。
 */
export const ENGINE_FAILURE_LIMIT = 2;

/**
 * エンジンのアプリを起動したあと、待ち受けが始まるまで待つ上限(秒)。
 * VOICEVOX は初回の起動に十数秒かかることがあるので、短くしすぎると
 * 「起動はしたのに間に合わず失敗になる」ことになる。
 */
export const ENGINE_LAUNCH_WAIT_SEC = 40;

/** エンジンが応答するか。 */
async function engineAlive(base) {
  try { await api.voicevoxVersion(base); return true; } catch { return false; }
}

/** foliate の SSML 文字列を [{mark, text}] の順序付き配列に変換。 */
export function parseSSML(ssmlString) {
  const doc = new DOMParser().parseFromString(ssmlString, 'application/xml');
  const root = doc.documentElement;
  const out = [];
  let curMark = null;
  let curText = '';
  const flush = () => {
    if (curText.trim()) out.push({ mark: curMark, text: curText.replace(/\s+/g, ' ').trim() });
    curText = '';
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      curText += n.textContent;
    } else if (n.nodeType === 1 && n.localName === 'mark') {
      flush();
      curMark = n.getAttribute('name');
    }
    // <break> 等は無視(VOICEVOX 側の pauseLengthScale で処理)
  }
  flush();
  return out;
}

// 現在文ハイライト。**foliate 本家の Overlayer をそのまま使う**(本文の上に矩形を重ねる)。
// Swift 版(プロトタイプ)の bridge.js もこれと同じ形で、色も同じ値にしてある。
//
// CSS Custom Highlight API(::highlight)は使わない。WebKit の縦書きで次の 3 つが起きるため:
//   - 帯が行の箱いっぱいに広がり、文字の並びに対して左右へずれる(短い行では片側に寄る)
//   - 文字が終わった後ろ——行末の空き——まで塗られる
//   - ルビの付いた文字のところで塗りが切れる
// Overlayer は range.getClientRects() が返す矩形をそのまま描くので、縦書きでも文字に合う。
//
// 描くのは Overlayer.highlight ではなく下の drawBand。理由は 2 つ:
//   - Overlayer.highlight は range.getClientRects() をそのまま描く。日本語の本文では
//     **ルビの付いた文字のところだけ矩形が二重になる**(ルビの箱の矩形と、文字の矩形)。
//     半透明の帯が重なるので、その行だけ色が濃くなり、行ごとに見え方が変わる。
//   - ルビの読み(rt)の矩形が混ざると、ルビのある行だけ帯がルビの側へ広がる。
// drawBand は「ルビの読みを除いた矩形」から「重なりを取り除いたもの」だけを描く。
//
// 不透明度 `var(--overlayer-highlight-opacity, .3)` は Overlayer.highlight と同じ値を使う。
// 下の色の alpha にさらに .3 が乗るので、文字の上に重なっても文字は沈まない。
// **この .3 を外さないこと。** 外すと帯が濃くなって本文が読めなくなる。
const HL_CURRENT_COLOR = 'rgba(255, 235, 59, 0.5)';   // 現在読んでいる文(Swift 版と同じ値)
const HL_PROGRESS_COLOR = 'rgba(255, 145, 0, 0.85)';  // 読み終わった部分(濃い方。カラオケ式)
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 他の矩形にすっぽり入っている矩形を取り除く(帯が二重に重なって濃くなるのを防ぐ)。 */
function dedupeRects(rects) {
  const sorted = [...rects].sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const out = [];
  const E = 0.5; // 端数の誤差
  for (const r of sorted) {
    const covered = out.some((o) => r.left >= o.left - E && r.top >= o.top - E
      && r.right <= o.right + E && r.bottom <= o.bottom + E);
    if (!covered) out.push(r);
  }
  return out;
}

/**
 * 帯を描く(Overlayer に渡す描画関数)。
 * Overlayer が渡してくる rects は使わず、options.range から自前で作り直す。
 */
function drawBand(rects, options = {}) {
  const { color = 'red', range, vertical = false } = options;
  let list = [...rects];
  if (range) {
    try {
      const base = baseRects(range);
      if (base.length) list = base;
    } catch { /* 作り直せなければ渡された矩形をそのまま使う */ }
  }
  list = evenThickness(dedupeRects(list), vertical);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('fill', color);
  g.style.opacity = 'var(--overlayer-highlight-opacity, .3)';
  for (const { left, top, height, width } of list) {
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', left);
    el.setAttribute('y', top);
    el.setAttribute('height', height);
    el.setAttribute('width', width);
    g.append(el);
  }
  return g;
}

/**
 * range の中の、ルビの読み(rt/rp)に属さない部分だけの矩形を集める。
 * getClientRects() をそのまま使うとルビの分だけ矩形が広がり、
 * ルビのある行だけ帯が太くなって片側へ膨らむ。
 */
function baseRects(range) {
  const doc = range.startContainer.ownerDocument;
  const root = range.commonAncestorContainer;
  const nodes = [];
  if (root.nodeType === 3) {
    // 文がテキストノード 1 つに収まる場合。createTreeWalker は root 自身を返さないので、
    // ここで拾わないと矩形が 1 つも取れない。
    nodes.push(root);
  } else {
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (nd) => (range.intersectsNode(nd) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) nodes.push(nd);
  }
  const out = [];
  for (const nd of nodes) {
    if (nd.parentElement?.closest('rt, rp')) continue;
    const r = doc.createRange();
    r.setStart(nd, nd === range.startContainer ? range.startOffset : 0);
    r.setEnd(nd, nd === range.endContainer ? range.endOffset : nd.textContent.length);
    for (const q of r.getClientRects()) if (q.width > 0 && q.height > 0) out.push(q);
  }
  return out;
}

/** その文書が縦書きか。 */
function isVerticalDoc(doc) {
  try {
    const wm = doc.defaultView.getComputedStyle(doc.body).writingMode;
    return wm === 'vertical-rl' || wm === 'vertical-lr';
  } catch { return false; }
}

/**
 * 帯の太さを行ごとにばらつかせない。
 * 縦書きなら幅を、横書きなら高さを、いちばん細いものに合わせ、帯の中心はそのままにする。
 * **1 行に収まる文でも、2 行にまたがる文でも、帯の太さが同じになる**ようにするため。
 */
function evenThickness(rects, vertical) {
  if (rects.length < 1) return rects;
  const size = (r) => (vertical ? r.width : r.height);
  const base = Math.min(...rects.map(size));
  if (!(base > 0)) return rects;
  return rects.map((r) => {
    if (vertical) {
      const cx = (r.left + r.right) / 2;
      return { left: cx - base / 2, top: r.top, width: base, height: r.height };
    }
    const cy = (r.top + r.bottom) / 2;
    return { left: r.left, top: cy - base / 2, width: r.width, height: base };
  });
}

/** range が載っているセクション(renderer の contents)を返す。CFI を作るのに index が要る。 */
function contentsFor(view, range) {
  const doc = range.startContainer.ownerDocument;
  return (view.renderer?.getContents?.() || []).find((c) => c.doc === doc);
}

// range の先頭から n 文字ぶんの部分 range を返す(カラオケ式ハイライト用)。
function subRangeTo(range, n) {
  const doc = range.startContainer.ownerDocument;
  const out = doc.createRange();
  out.setStart(range.startContainer, range.startOffset);
  out.setEnd(range.startContainer, range.startOffset);
  let remaining = Math.max(0, n);
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
    acceptNode: (nd) => (range.intersectsNode(nd) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) {
    const startOff = nd === range.startContainer ? range.startOffset : 0;
    const endOff = nd === range.endContainer ? range.endOffset : nd.textContent.length;
    const avail = endOff - startOff;
    if (remaining <= avail) { out.setEnd(nd, startOff + remaining); return out; }
    remaining -= avail;
    out.setEnd(nd, endOff);
    if (nd === range.endContainer) break;
  }
  return out;
}

export class TTSController {
  #view;
  #getSettings;
  #onState;
  #onError;
  #onNotice;
  playing = false;
  paused = false;
  #audio = null;
  #dict = [];        // コンパイル済みの読み辞書(dictionary.compile() の戻り)
  #dictVersion = 0;  // 先読みキャッシュを辞書変更で無効化するための世代番号

  /**
   * @param {(state:{playing:boolean,paused:boolean}) => void} [onState]
   * @param {(code:'ENGINE_UNREACHABLE') => void} [onError]
   *   利用者に伝えるべき失敗。文言はここでは決めない(DOM も i18n も持たない層なので、
   *   呼び出し側が翻訳して出す)。
   */
  constructor(view, getSettings, onState = () => {}, onError = () => {}, onNotice = () => {}) {
    this.#view = view;
    this.#getSettings = getSettings;
    this.#onState = onState;
    this.#onError = onError;
    this.#onNotice = onNotice;
    this.highlight = (range) => { this.#curRange = range.cloneRange(); this.#drawCurrent(range); };
  }
  #curRange = null;
  #hasPlaced = false;     // 「この場所だけ」の登録があるか
  #progressRange = null;  // 読み終わった部分(カラオケ式)の範囲
  #hlCurrent = null;      // 現在文の帯に使っている CFI(annotation の値)
  #hlProgress = null;     // 読み終わった部分の帯に使っている CFI
  #overlayWired = false;  // draw-annotation を受け取る配線を済ませたか

  /**
   * 帯の描き方を view に教える(1 回だけ)。
   * foliate は annotation を描くとき draw-annotation を投げてきて、
   * 受け取った側が draw(描画関数, 色) を呼ぶと、その形で本文の上に重なる。
   */
  #wireOverlay() {
    if (this.#overlayWired) return;
    this.#overlayWired = true;
    this.#view.addEventListener('draw-annotation', (e) => {
      const { draw, annotation } = e.detail || {};
      if (!draw) return;
      // range は draw の中で矩形を作り直すために渡す(ルビを除く・重なりを取り除く・太さを揃える)。
      const opts = { range: e.detail.range, vertical: isVerticalDoc(e.detail.doc) };
      if (annotation?.ttsRole === 'current') draw(drawBand, { ...opts, color: HL_CURRENT_COLOR });
      else if (annotation?.ttsRole === 'progress') draw(drawBand, { ...opts, color: HL_PROGRESS_COLOR });
    });
  }

  // 帯の付け外しを順番どおりに行うための待ち行列。
  // view.addAnnotation / deleteAnnotation はどちらも非同期で、CFI の解決を待ってから
  // 実際に描く・消すという作りになっている。呼びっぱなしにすると、消す処理より先に
  // 次の文の描く処理が終わってしまい、**前の文の帯が消えずに残る**。
  #bandQueue = Promise.resolve();
  #enqueue(fn) { this.#bandQueue = this.#bandQueue.then(fn).catch(() => {}); }

  /** 現在文の帯を張り替える(前の文の帯と、前の文のカラオケ塗りは消す)。 */
  #drawCurrent(range) {
    const view = this.#view;
    this.#wireOverlay();
    const c = contentsFor(view, range);
    if (c) {
      this.#progressRange = null;
      this.#enqueue(async () => {
        // 先に消してから足す。順番が入れ替わると前の文の帯が残る。
        await this.#removeBand('progress');
        await this.#removeBand('current');
        const cfi = view.getCFI(c.index, range);
        this.#hlCurrent = cfi;
        await view.addAnnotation({ value: cfi, ttsRole: 'current' });
      });
    }
    // 現在文を画面内へ(縦書き横スクロール/ページ送りに追従)。
    // **第 2 引数を渡さないこと。** 渡すと foliate は relocate の理由を 'selection' にして、
    // その文を**まるごと選択状態にする**(paginator.js の setSelectionTo)。
    // すると OS の選択色の帯が、こちらが描く帯とは別に重なって出る。その帯は
    // 行の箱いっぱいに広がり、文字の後ろまで伸び、ルビの側へ膨らみ、2 行にまたがると
    // つながって見える。Swift 版(プロトタイプ)も第 2 引数は渡していない。
    try { view.renderer.scrollToAnchor?.(range); } catch { /* noop */ }
  }

  /** 読み終わった部分の帯を、いまの長さに合わせて張り替える。 */
  #drawProgress(sub) {
    const view = this.#view;
    const c = contentsFor(view, sub);
    if (!c) return;
    let cfi;
    try { cfi = view.getCFI(c.index, sub); } catch { return; }
    if (cfi === this.#hlProgress) return;  // 長さが変わっていないなら描き直さない
    this.#progressRange = sub;
    this.#enqueue(async () => {
      await this.#removeBand('progress');
      this.#hlProgress = cfi;
      await view.addAnnotation({ value: cfi, ttsRole: 'progress' });
    });
  }

  /** 張ってある帯を 1 本消す。kind は 'current' か 'progress'。 */
  async #removeBand(kind) {
    const cfi = kind === 'current' ? this.#hlCurrent : this.#hlProgress;
    if (!cfi) return;
    if (kind === 'current') this.#hlCurrent = null; else this.#hlProgress = null;
    try { await this.#view.deleteAnnotation({ value: cfi }); } catch { /* noop */ }
  }

  /** 帯を全部消す。 */
  #clearHighlights() {
    this.#curRange = null;
    this.#progressRange = null;
    this.#enqueue(async () => {
      await this.#removeBand('progress');
      await this.#removeBand('current');
    });
  }

  /** いま読んでいる文のテキスト(テストバスの highlightedText 用)。 */
  highlightedText() {
    return (this.#curRange?.toString() || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 診断用: いま読んでいる文が本のどこにあるか。{ section, offset }。
   * 「この場所だけ」の登録が、実際にどの位置と照合されるかを外から確かめるために使う。
   */
  highlightPlace() {
    const r = this.#curRange;
    if (!r) return null;
    try {
      const doc = r.startContainer.ownerDocument;
      const contents = (this.#view.renderer?.getContents?.() || []).find((c) => c.doc === doc);
      if (!contents) return null;
      const head = doc.createRange();
      head.setStart(doc.body, 0);
      head.setEnd(r.startContainer, r.startOffset);
      return { section: contents.index, offset: head.toString().length };
    } catch { return null; }
  }

  /** 診断用: 現在文の矩形。ルビ込みと、ルビの読みを除いたものを並べて返す。 */
  highlightRects() {
    const r = this.#curRange;
    if (!r) return null;
    const q = (x) => Math.round(x * 10) / 10;
    const pack = (rects) => [...rects].map((v) => ({ x: q(v.left), y: q(v.top), w: q(v.width), h: q(v.height) }));
    let wm = '';
    try {
      const doc = r.startContainer.ownerDocument;
      wm = doc.defaultView.getComputedStyle(doc.body).writingMode;
    } catch { /* noop */ }
    return { writingMode: wm, withRuby: pack(r.getClientRects()), baseOnly: pack(baseRects(r)) };
  }

  /** 診断用: 現在文と読み終わった部分の範囲テキスト(先頭 20 字)。 */
  highlightInfo() {
    const out = {};
    const head = (r) => (r?.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (this.#curRange) out.tts = [head(this.#curRange)];
    if (this.#progressRange) out['tts-progress'] = [head(this.#progressRange)];
    return out;
  }

  #emit() { this.#onState({ playing: this.playing, paused: this.paused }); }

  /**
   * 読み上げエンジンに繋がることを確かめる。繋がらなければアプリを起動して、
   * 待ち受けが始まるまで待つ。
   *
   * 起動を試みるのは設定が VOICEVOX か AivisSpeech のときだけ。
   * 「カスタム」はどのアプリを立ち上げればよいか分からないので、起動は試みない。
   *
   * @param {() => boolean} isAborted 待っている間に止められたかを返す関数
   * @returns {Promise<'ok'|'unreachable'|'launch-failed'>}
   */
  async #ensureEngine(isAborted = () => false) {
    const s = this.#getSettings();
    const base = engineBaseUrl(s);
    if (await engineAlive(base)) return 'ok';
    if (s.engine !== 'voicevox' && s.engine !== 'aivis') return 'unreachable';
    this.#onNotice('ENGINE_STARTING');
    try { await api.launchTtsEngine(s.engine); } catch { return 'launch-failed'; }
    for (let i = 0; i < ENGINE_LAUNCH_WAIT_SEC; i++) {
      await sleep(1000);
      if (isAborted()) return 'launch-failed';
      if (await engineAlive(base)) { this.#onNotice('ENGINE_READY'); return 'ok'; }
    }
    return 'launch-failed';
  }

  /**
   * 読み辞書を差し替える(dictionary.compile() の戻り値)。
   * エンジンのユーザー辞書は使わない。短い登録語が長い熟語を食い荒らすのを
   * 原理的に防げないため、アプリ側のレイヤー付き前処理に一本化する(§10.2)。
   */
  setDictionary(compiled) {
    this.#dict = Array.isArray(compiled) ? compiled : [];
    // 場所を決めた登録が 1 つも無ければ、文ごとの位置を数えない(数えるのに費用がかかる)。
    this.#hasPlaced = this.#dict.some((e) => e?.at);
    this.#dictVersion++;
    this.#synthCache.clear();
  }

  async play(compiled) {
    if (this.playing && this.paused) { this.resume(); return; }
    if (this.playing) return;
    if (compiled) this.setDictionary(compiled);
    this.playing = true; this.paused = false; this.#synthFailures = 0; this.#emit();
    const ready = await this.#ensureEngine(() => !this.playing);
    if (ready !== 'ok') {
      if (this.playing) { this.stop(); this.#onError(ready === 'launch-failed' ? 'ENGINE_LAUNCH_FAILED' : 'ENGINE_UNREACHABLE'); }
      return;
    }
    try {
      await this.#view.initTTS('sentence', this.highlight);
      let ssml = this.#view.tts.start();
      await this.#loop(ssml);
    } catch (e) {
      console.error('TTS error', e);
      this.stop();
    }
  }

  /**
   * 現在表示中の章(セクション)の全文を文単位で音声合成する。
   * - 再生中なら停止してから走査する(view.tts のイテレータを共有するため)。
   * - setMark は呼ばないのでハイライト/スクロールは動かない(highlight は再生用のまま渡す)。
   * - 合成に失敗した文はテキスト・音声とも捨てる(両者の対応を保つため。動画の字幕同期に必須)。
   * @returns {Promise<Array<{text:string, wav:string}>>} 文ごとの {テキスト, WAV(base64)}
   */
  async synthSection({ onProgress } = {}) {
    const s = this.#getSettings();
    if (this.playing) this.stop();
    const ready = await this.#ensureEngine();
    if (ready !== 'ok') {
      const e = new Error('ENGINE_UNREACHABLE');
      e.code = ready === 'launch-failed' ? 'ENGINE_LAUNCH_FAILED' : 'ENGINE_UNREACHABLE';
      throw e;
    }
    const base = engineBaseUrl(s);
    await this.#view.initTTS('sentence', this.highlight);
    // 場所はその場で取る。tts.next() を呼ぶと #ranges が次のブロックへ入れ替わり、
    // あとから mark で引けなくなる。
    const items = [];
    let ssml = this.#view.tts.start();
    while (ssml) {
      for (const seg of parseSSML(ssml)) if (seg.text) items.push({ text: seg.text, place: this.#placeOf(seg) });
      ssml = this.#view.tts.next();
    }
    if (!items.length) { const e = new Error('EMPTY'); e.code = 'EMPTY'; throw e; }
    const segments = [];
    for (let i = 0; i < items.length; i++) {
      onProgress?.(i, items.length);
      try {
        const wav = await this.#synth(base, s, items[i].text, items[i].place);
        segments.push({ text: items[i].text, wav });
      } catch (err) { console.error('synthSection failed', err); }
    }
    onProgress?.(items.length, items.length);
    if (!segments.length) { const e = new Error('SYNTH_FAILED'); e.code = 'SYNTH_FAILED'; throw e; }
    return segments;
  }

  /**
   * 現在の章を丸ごと音声合成し、連結した WAV を base64 で返す(保存はしない)。
   * 保存先の決定・書き込みは呼び出し側(macOS 保存パネル等)に委ねる。
   * @returns {Promise<string>} 連結 WAV の base64
   */
  async makeSectionWavB64({ onProgress } = {}) {
    const segments = await this.synthSection({ onProgress });
    return api.mergeWavB64(segments.map((s) => s.wav));
  }

  // 指定の range(選択語など)の位置から読み上げ開始。
  async playFrom(range, compiled) {
    this.stop();
    if (compiled) this.setDictionary(compiled);
    this.playing = true; this.paused = false; this.#synthFailures = 0; this.#emit();
    const ready = await this.#ensureEngine(() => !this.playing);
    if (ready !== 'ok') {
      if (this.playing) { this.stop(); this.#onError(ready === 'launch-failed' ? 'ENGINE_LAUNCH_FAILED' : 'ENGINE_UNREACHABLE'); }
      return;
    }
    try {
      await this.#view.initTTS('sentence', this.highlight);
      const ssml = this.#view.tts.from(range);
      await this.#loop(ssml);
    } catch (e) {
      console.error('TTS playFrom error', e);
      this.stop();
    }
  }

  async #loop(firstSSML) {
    let segs = firstSSML ? parseSSML(firstSSML) : [];
    while (this.playing) {
      const { r, nextSegs } = await this.#runBlock(segs);
      if (r === 'stop') return;
      if (r === 'unreachable') { this.stop(); this.#onError('ENGINE_UNREACHABLE'); return; }
      if (nextSegs !== undefined) {
        segs = nextSegs;
      } else {
        // 空ブロック等で先行取得していない場合はここで次ブロックへ
        const ssml = this.#view.tts.next();
        segs = ssml ? parseSSML(ssml) : null;
      }
      if (segs === null) {
        // セクション末尾 → 次セクション
        const moved = await this.#advanceSection();
        if (!moved) { this.#finish(); return; }
        await this.#view.initTTS('sentence', this.highlight);
        const ssml = this.#view.tts.start();
        if (!ssml) { this.#finish(); return; }
        segs = parseSSML(ssml);
      }
    }
  }

  // 連続でこの数だけ合成に失敗したら「エンジンに届いていない」と判断して止める。
  // 1 でも動くが、一時的な取りこぼし 1 回で止まるのは過敏なので 2 にしてある。
  #synthFailures = 0;

  // 先読み: 再生中の文より後の文をバックグラウンドで合成しておく数
  #prefetchCount = 2;
  /**
   * その文が本のどこにあるかを返す。{ section: 章の番号, offset: 章の先頭から数えた文字数 }。
   *
   * 「この場所だけ」の登録を照合するために使う。場所を決めた登録が 1 つも無いときは
   * 数えない——1 文ごとに章の先頭からの文字数を数え直すので、ただではない。
   *
   * mark から range を引くのに、foliate の TTS に足した rangeOf を使う。setMark だと
   * ハイライトが動いてしまい、まだ読んでいない文へ先に飛んでしまう。
   */
  #placeOf(seg) {
    if (!this.#hasPlaced || !seg?.mark) return null;
    try {
      const range = this.#view.tts?.rangeOf?.(seg.mark);
      if (!range) return null;
      const doc = range.startContainer.ownerDocument;
      const contents = (this.#view.renderer?.getContents?.() || []).find((c) => c.doc === doc);
      if (!contents) return null;
      const head = doc.createRange();
      head.setStart(doc.body, 0);
      head.setEnd(range.startContainer, range.startOffset);
      return { section: contents.index, offset: head.toString().length };
    } catch { return null; }
  }

  #synthCache = new Map(); // key -> Promise<b64>

  // 場所も鍵に入れる。同じ文字列でも、本のどこにあるかで読みが変わりうるため
  // (「この場所だけ」の登録)。
  #synthKey(base, s, text, place) {
    return [base, s.speaker, s.speedScale, s.pauseLengthScale, this.#dictVersion,
      place ? `${place.section}:${place.offset}` : '', text].join('\u0000');
  }

  /** 読み辞書を適用してから合成する(表示は原文のまま。読みにだけ効く)。 */
  #synth(base, s, text, place = null) {
    const r = prepareReading(text, this.#dict, place);
    return api.voicevoxSynthesize(base, r.text, s.speaker, s.speedScale, s.pauseLengthScale, r);
  }

  /** items({text, place}) をバックグラウンドで合成開始(既に開始済みならスキップ)。 */
  #synthAhead(base, s, items) {
    for (const { text, place } of items) {
      const key = this.#synthKey(base, s, text, place);
      if (this.#synthCache.has(key)) continue;
      const p = this.#synth(base, s, text, place);
      p.catch(() => this.#synthCache.delete(key)); // 失敗分は再生時に再試行させる
      this.#synthCache.set(key, p);
    }
    // 設定変更などで使われなかった分が残らないよう上限を設ける(古いものから捨てる)
    while (this.#synthCache.size > 16) this.#synthCache.delete(this.#synthCache.keys().next().value);
  }

  async #getAudio(base, s, text, place = null) {
    const key = this.#synthKey(base, s, text, place);
    const cached = this.#synthCache.get(key);
    if (cached) {
      try { return await cached; } finally { this.#synthCache.delete(key); }
    }
    return this.#synth(base, s, text, place);
  }

  // segs(現在ブロックの文配列)を順に再生。最終文の再生中に次ブロックを先行取得して返す。
  // 戻り値: { r: 'stop'|'done', nextSegs?: 配列 | null(セクション末尾) }。nextSegs 省略時は未取得。
  async #runBlock(segs) {
    const s = this.#getSettings();
    const base = engineBaseUrl(s);
    let nextSegs;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!this.playing) return { r: 'stop' };
      // 一時停止中は待機(現在文を保持)
      while (this.paused && this.playing) await sleep(80);
      if (!this.playing) return { r: 'stop' };
      // 場所は setMark より前に取る(rangeOf はハイライトを動かさないので順番は自由だが、
      // #ranges が入れ替わる tts.next() より前である必要がある)。
      const place = this.#placeOf(seg);
      try { this.#view.tts.setMark(seg.mark); } catch { /* noop */ }
      // 同ブロックの後続文を先読み
      this.#synthAhead(base, s, segs.slice(i + 1, i + 1 + this.#prefetchCount)
        .map((x) => ({ text: x.text, place: this.#placeOf(x) })));
      // 最終文の setMark 後は tts の内部状態(#ranges)をもう参照しないので、
      // ここで次ブロックへ先行して進め、その先頭文も先読みする(ハイライトを壊さない唯一のタイミング)
      if (i === segs.length - 1) {
        const nx = this.#view.tts.next();
        nextSegs = nx ? parseSSML(nx) : null;
        // ここは tts.next() の直後なので、#ranges は既に次ブロックのものになっている。
        if (nextSegs) this.#synthAhead(base, s, nextSegs.slice(0, this.#prefetchCount)
          .map((x) => ({ text: x.text, place: this.#placeOf(x) })));
      }
      let b64;
      try {
        b64 = await this.#getAudio(base, s, seg.text, place);
        this.#synthFailures = 0;
      } catch (e) {
        console.error('synthesize failed', e);
        // 1 文だけの失敗は飛ばす(その文が読めないだけで、読み上げは続けたい)。
        // ただし**続けて何文も失敗するのはエンジンに届いていない**ということなので、
        // 黙って進めない——エンジンを入れていない人が「再生中なのに無音」を
        // 延々見せられることになる(既定では別途インストールが要る)。
        if (++this.#synthFailures >= ENGINE_FAILURE_LIMIT) return { r: 'unreachable' };
        continue;
      }
      if (!this.playing) return { r: 'stop' };
      await this.#playWav(b64);
    }
    // 段落境界の間(改行の待ち時間)。pauseLengthScale に比例。
    await sleep(120 * (s.pauseLengthScale || 1));
    return { r: 'done', nextSegs };
  }

  #playWav(b64) {
    return new Promise((resolve) => {
      const audio = new Audio('data:audio/wav;base64,' + b64);
      this.#audio = audio;
      // L3: 再生時間に比例して現在文内を伸ばすカラオケ式ハイライト
      const range = this.#curRange;
      const total = range ? range.toString().length : 0;
      const onTime = () => {
        if (!range || !audio.duration) return;
        const frac = Math.min(1, audio.currentTime / audio.duration);
        const n = Math.round(frac * total);
        if (n <= 0) return; // 長さ 0 の範囲は帯にしない
        try { this.#drawProgress(subRangeTo(range, n)); } catch { /* noop */ }
      };
      audio.addEventListener('timeupdate', onTime);
      const done = () => {
        audio.onended = null; audio.onerror = null;
        audio.removeEventListener('timeupdate', onTime);
        // 文の読了時は読み終わった部分を文の全域へ
        try { if (range) this.#drawProgress(range.cloneRange()); } catch { /* noop */ }
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      if (this.paused) { this.#pendingAudio = audio; }
      else audio.play().catch(done);
    });
  }

  async #advanceSection() {
    const view = this.#view;
    const contents = view.renderer?.getContents?.() || [];
    let idx = contents[0]?.index;
    if (idx == null) idx = this.#lastIndex ?? 0;
    const sections = view.book?.sections || [];
    let next = idx + 1;
    while (next < sections.length && sections[next]?.linear === 'no') next++;
    if (next >= sections.length) return false;
    this.#lastIndex = next;
    try { await view.goTo({ index: next, anchor: 0 }); return true; }
    catch { return false; }
  }

  pause() {
    if (!this.playing) return;
    this.paused = true;
    try { this.#audio?.pause(); } catch { /* noop */ }
    this.#emit();
  }
  resume() {
    if (!this.playing) return;
    this.paused = false;
    try { this.#audio?.play?.().catch(() => {}); } catch { /* noop */ }
    this.#emit();
  }
  stop() {
    this.playing = false; this.paused = false;
    try { this.#audio?.pause(); } catch { /* noop */ }
    this.#audio = null;
    this.#synthCache.clear();
    this.#clearHighlights();
    this.#emit();
  }
  #finish() {
    this.playing = false; this.paused = false;
    this.#synthCache.clear();
    this.#clearHighlights();
    this.#emit();
  }

  #lastIndex = null;
  #pendingAudio = null;
}

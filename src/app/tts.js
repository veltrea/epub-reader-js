// 読み上げ制御。
// - 文分割/ハイライト/章内の走査は foliate-js の TTS(view.initTTS)を再利用。
// - 音声だけ VOICEVOX/AivisSpeech に差し替える(SSML から文テキストを取り出して各文を合成)。
// - 現在文は CSS Custom Highlight API で強調し、foliate の scrollToAnchor で追従。
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

// 現在文ハイライト(セクション文書ごとに CSS Custom Highlight を張る)。
function ensureHighlightStyle(doc) {
  if (doc.__ttsStyled) return;
  const style = doc.createElement('style');
  // tts=現在文(淡色), tts-progress=読み上げ済み部分(濃色, カラオケ式)
  style.textContent = `::highlight(tts){background-color: rgba(255,214,0,.25); color: inherit;}
::highlight(tts-progress){background-color: rgba(255,190,0,.55); color: inherit;}`;
  (doc.head || doc.documentElement).appendChild(style);
  doc.__ttsStyled = true;
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
function highlightRange(view, range) {
  try {
    const node = range.startContainer;
    const doc = node.ownerDocument || node;
    const win = doc.defaultView;
    if (win && win.CSS && win.Highlight && win.CSS.highlights) {
      ensureHighlightStyle(doc);
      // 前文のカラオケ塗りを明示的に消す。set での置換だけに頼ると
      // WebKit(縦書き多段組)が旧範囲の再描画をスキップして塗り残骸が蓄積する。
      win.CSS.highlights.delete('tts-progress');
      const h = new win.Highlight(range.cloneRange());
      win.CSS.highlights.set('tts', h);
    }
  } catch { /* ハイライト不可でも読み上げは続行 */ }
  // 現在文を画面内へ(縦書き横スクロール/ページ送りに追従)
  try { view.renderer.scrollToAnchor?.(range, true); } catch { /* noop */ }
}
function clearHighlights(view) {
  for (const c of view.renderer?.getContents?.() || []) {
    try { c.doc?.defaultView?.CSS?.highlights?.delete('tts'); } catch { /* noop */ }
    try { c.doc?.defaultView?.CSS?.highlights?.delete('tts-progress'); } catch { /* noop */ }
  }
}

export class TTSController {
  #view;
  #getSettings;
  #onState;
  #onError;
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
  constructor(view, getSettings, onState = () => {}, onError = () => {}) {
    this.#view = view;
    this.#getSettings = getSettings;
    this.#onState = onState;
    this.#onError = onError;
    this.highlight = (range) => { this.#curRange = range.cloneRange(); highlightRange(this.#view, range); };
  }
  #curRange = null;

  #emit() { this.#onState({ playing: this.playing, paused: this.paused }); }

  /**
   * 読み辞書を差し替える(dictionary.compile() の戻り値)。
   * エンジンのユーザー辞書は使わない。短い登録語が長い熟語を食い荒らすのを
   * 原理的に防げないため、アプリ側のレイヤー付き前処理に一本化する(§10.2)。
   */
  setDictionary(compiled) {
    this.#dict = Array.isArray(compiled) ? compiled : [];
    this.#dictVersion++;
    this.#synthCache.clear();
  }

  async play(compiled) {
    if (this.playing && this.paused) { this.resume(); return; }
    if (this.playing) return;
    if (compiled) this.setDictionary(compiled);
    this.playing = true; this.paused = false; this.#synthFailures = 0; this.#emit();
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
    const base = engineBaseUrl(s);
    await this.#view.initTTS('sentence', this.highlight);
    const texts = [];
    let ssml = this.#view.tts.start();
    while (ssml) {
      for (const seg of parseSSML(ssml)) if (seg.text) texts.push(seg.text);
      ssml = this.#view.tts.next();
    }
    if (!texts.length) { const e = new Error('EMPTY'); e.code = 'EMPTY'; throw e; }
    const segments = [];
    for (let i = 0; i < texts.length; i++) {
      onProgress?.(i, texts.length);
      try {
        const wav = await this.#synth(base, s, texts[i]);
        segments.push({ text: texts[i], wav });
      } catch (err) { console.error('synthSection failed', err); }
    }
    onProgress?.(texts.length, texts.length);
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
  #synthCache = new Map(); // key -> Promise<b64>

  #synthKey(base, s, text) {
    return [base, s.speaker, s.speedScale, s.pauseLengthScale, this.#dictVersion, text].join('\u0000');
  }

  /** 読み辞書を適用してから合成する(表示は原文のまま。読みにだけ効く)。 */
  #synth(base, s, text) {
    const r = prepareReading(text, this.#dict);
    return api.voicevoxSynthesize(base, r.text, s.speaker, s.speedScale, s.pauseLengthScale, r);
  }

  /** texts をバックグラウンドで合成開始(既に開始済みならスキップ)。 */
  #synthAhead(base, s, texts) {
    for (const text of texts) {
      const key = this.#synthKey(base, s, text);
      if (this.#synthCache.has(key)) continue;
      const p = this.#synth(base, s, text);
      p.catch(() => this.#synthCache.delete(key)); // 失敗分は再生時に再試行させる
      this.#synthCache.set(key, p);
    }
    // 設定変更などで使われなかった分が残らないよう上限を設ける(古いものから捨てる)
    while (this.#synthCache.size > 16) this.#synthCache.delete(this.#synthCache.keys().next().value);
  }

  async #getAudio(base, s, text) {
    const key = this.#synthKey(base, s, text);
    const cached = this.#synthCache.get(key);
    if (cached) {
      try { return await cached; } finally { this.#synthCache.delete(key); }
    }
    return this.#synth(base, s, text);
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
      try { this.#view.tts.setMark(seg.mark); } catch { /* noop */ }
      // 同ブロックの後続文を先読み
      this.#synthAhead(base, s, segs.slice(i + 1, i + 1 + this.#prefetchCount).map((x) => x.text));
      // 最終文の setMark 後は tts の内部状態(#ranges)をもう参照しないので、
      // ここで次ブロックへ先行して進め、その先頭文も先読みする(ハイライトを壊さない唯一のタイミング)
      if (i === segs.length - 1) {
        const nx = this.#view.tts.next();
        nextSegs = nx ? parseSSML(nx) : null;
        if (nextSegs) this.#synthAhead(base, s, nextSegs.slice(0, this.#prefetchCount).map((x) => x.text));
      }
      let b64;
      try {
        b64 = await this.#getAudio(base, s, seg.text);
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
        if (n <= 0) return; // collapsed range を set しない(WebKit が旧範囲を再描画しないため)
        try {
          const sub = subRangeTo(range, n);
          const doc = range.startContainer.ownerDocument;
          const win = doc.defaultView;
          if (win?.Highlight && win.CSS?.highlights) win.CSS.highlights.set('tts-progress', new win.Highlight(sub));
        } catch { /* noop */ }
      };
      audio.addEventListener('timeupdate', onTime);
      const done = () => {
        audio.onended = null; audio.onerror = null;
        audio.removeEventListener('timeupdate', onTime);
        // 文の読了時は progress を全域に
        try {
          if (range) { const doc = range.startContainer.ownerDocument; doc.defaultView?.CSS?.highlights?.set('tts-progress', new doc.defaultView.Highlight(range.cloneRange())); }
        } catch { /* noop */ }
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
    clearHighlights(this.#view);
    this.#emit();
  }
  #finish() {
    this.playing = false; this.paused = false;
    this.#synthCache.clear();
    clearHighlights(this.#view);
    this.#emit();
  }

  #lastIndex = null;
  #pendingAudio = null;
}

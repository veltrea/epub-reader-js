// 対訳(OpenAI 互換 API。LM Studio 等の手元のサーバーでも、クラウドのサービスでもよい)。
// 移植元(Swift 版プロトタイプ)の仕様書 §13 に対応。
//
// 方針: **本文(原文)はそのまま左に残し、訳を右のペインに出す。**
// foliate の列レイアウトへ訳文を割り込ませると、画像ページ・見開き・縦書きの組みと
// 衝突して破綻するため。結果として「左＝原書 / 右＝訳」というレイアウトになる。

import * as api from './api.js';

/** 対応言語。**プロンプトには英語名で渡す**(モデルの追従率が素直に高い)。 */
export const LANGS = {
  auto: 'the source language',
  ja: 'Japanese',
  en: 'English',
  zh: 'Chinese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
};

export const DEFAULT_TRANSLATION = {
  baseURL: 'http://127.0.0.1:1234',
  apiKey: '',             // 空 = 認証なし(ローカル)。クラウドの OpenAI 互換 API はここにキーを入れる
  model: '',              // 空 = 一覧の先頭を使う
  sourceLanguage: 'auto',
  targetLanguage: 'ja',
  useContext: true,
  concurrency: 2,         // 1–8
  temperature: 0.2,
  disableThinking: true,
  // 推論モデルの思考を止める第2の手段。**ローカルではこれだけが効く。**
  // 実測(2026-08-09, qwen3.5-9b): chat_template_kwargs も reasoning_effort も /no_think も
  // 一切効かず、max_tokens 4000 を全部思考に使い切って本文が 0 トークンになった。
  // assistant に空の <think></think> を置いて発話を継続させると 90 秒 → 2 秒になる。
  // ただし prefill(assistant で終わるメッセージ列)を受けないクラウド API があるので切れるようにする。
  prefillThinkClose: true,
};

/** 可視範囲から拾う段落の上限。1 画面に収まる段落は普通 10 前後。 */
export const MAX_PASSAGES = 40;
/** ページ送りのたびに毎回 LLM を叩かないためのデバウンス。 */
export const REFRESH_DEBOUNCE_MS = 400;
const CACHE_LIMIT = 4000;

// ---------------------------------------------------------------------------
// プロンプト(純粋)
// ---------------------------------------------------------------------------

export function systemPrompt({ sourceLanguage, targetLanguage }) {
  const src = LANGS[sourceLanguage] || LANGS.auto;
  // auto は訳文側の指定になりえない(「原文の言語へ訳せ」になってしまう)ので ja へ倒す。
  const dst = (targetLanguage !== 'auto' && LANGS[targetLanguage]) || LANGS.ja;
  return `You are a professional literary translator. Translate the given passage from ${src} into ${dst}.

Rules:
- Output ONLY the translation. No preface, no notes, no romanization, no quotation marks around the whole output.
- Translate the passage as a whole; keep the author's tone, register and paragraph structure.
- Keep proper nouns consistent. Do not add or drop information.
- If the passage is a heading or a fragment, translate it as such — do not turn it into a sentence.`;
}

export function userPrompt(text, context) {
  if (!context) return text;
  return `[Context — the preceding passage. Do NOT translate this part.]
${context}

[Passage to translate]
${text}`;
}

// ---------------------------------------------------------------------------
// 応答のクリーニング(純粋)
// ---------------------------------------------------------------------------

// 「Japanese: …」のような前置きを剥がす。訳文の言語は設定で変わるので、
// 言語名は LANGS から起こす(ja→en のとき 'english:' が残る不具合があった)。
const LABELS = [
  'translation:', 'translated:', 'translated text:', '訳:', '日本語訳:', '翻訳:',
  ...Object.entries(LANGS).filter(([k]) => k !== 'auto').map(([, v]) => `${v.toLowerCase()}:`),
];
const QUOTE_PAIRS = [['"', '"'], ['「', '」'], ['“', '”'], ['『', '』']];

export function cleanCompletion(raw) {
  let s = String(raw ?? '');
  // 1. <think>…</think> を除去(閉じタグが無いまま切れていたら開始タグ以降を全部落とす)
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = s.toLowerCase().indexOf('<think>');
  if (open >= 0) s = s.slice(0, open);
  s = s.trim();
  // 2. 行頭のラベルを 1 つだけ剥がす
  for (const label of LABELS) {
    if (s.toLowerCase().startsWith(label)) { s = s.slice(label.length).trim(); break; }
  }
  // 3. 全体を囲む引用符を外す(内側に閉じ記号が出てこない場合だけ)
  for (const [o, c] of QUOTE_PAIRS) {
    if (s.length >= 2 && s.startsWith(o) && s.endsWith(c)) {
      const inner = s.slice(o.length, s.length - c.length);
      if (!inner.includes(c)) { s = inner; break; }
    }
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// キャッシュ
// ---------------------------------------------------------------------------

// SHA256 は WebView で同期に取れないので、衝突確率が実用上十分低い 64bit 相当の
// FNV-1a を 2 本(異なるオフセット)回して連結する。キャッシュキー用途にのみ使う。
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** 訳文をキャッシュする鍵。**言語は原文側も含める**(ja→en と en→ja が同じ鍵になっていた)。 */
export function langPair(cfg) {
  return `${cfg?.sourceLanguage || 'auto'}>${cfg?.targetLanguage || 'ja'}`;
}
export function cacheKey(model, pair, source) {
  const s = `${model}|${pair}|${source}`;
  return fnv1a(s, 0x811c9dc5).toString(16).padStart(8, '0')
    + fnv1a(s, 0x9e3779b1).toString(16).padStart(8, '0');
}

export class TranslationCache {
  #map = new Map();
  #dirty = false;
  #timer = null;
  #save;

  constructor(save) { this.#save = save; }

  load(obj) {
    this.#map = new Map(Object.entries(obj || {}));
  }
  get size() { return this.#map.size; }
  get(key) { return this.#map.get(key) ?? null; }
  set(key, value) {
    this.#map.set(key, value);
    // 上限を超えたら挿入順に古いものから落とす
    while (this.#map.size > CACHE_LIMIT) this.#map.delete(this.#map.keys().next().value);
    this.#dirty = true;
    this.#schedule();
  }
  clear() {
    this.#map.clear();
    this.#dirty = true;
    this.#schedule();
  }
  // 段落ごとに数百件の I/O を出さないよう 2 秒のデバウンスで束ねる
  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#dirty) return;
      this.#dirty = false;
      try { this.#save(Object.fromEntries(this.#map)); } catch { /* noop */ }
    }, 2000);
  }
  flush() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#dirty) { this.#dirty = false; try { this.#save(Object.fromEntries(this.#map)); } catch { /* noop */ } }
  }
}

// ---------------------------------------------------------------------------
// 段落抽出(DOM)
// ---------------------------------------------------------------------------

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, figcaption, td, th, pre';

/**
 * 可視範囲の段落を抽出する。
 * 入れ子(li の中の p 等)は**内側だけ**採る(両方採ると同じ文を二度訳す)。
 * 画像だけのページは訳す本文がないので reason を返す。
 * @returns {{passages: Array<{key:string, text:string, el:Element}>, reason?: string}}
 */
export function extractPassages(doc, range) {
  if (!doc?.body) return { passages: [], reason: 'no-doc' };
  const all = [...doc.body.querySelectorAll(BLOCK_SELECTOR)];
  // 入れ子の外側を捨てる
  const inner = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  const seen = new Set();
  const passages = [];
  for (const el of inner) {
    if (range) {
      try { if (!range.intersectsNode(el)) continue; } catch { /* 判定不能なら採る */ }
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = cacheKey('', '', text);
    if (seen.has(key)) continue;
    seen.add(key);
    passages.push({ key, text, el });
    if (passages.length >= MAX_PASSAGES) break;
  }
  if (!passages.length) {
    const hasImage = !!doc.body.querySelector('img, svg, image');
    return { passages: [], reason: hasImage ? 'image-page' : 'empty' };
  }
  return { passages };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * 段落列を訳す。終わった行から順に onRow で返す(待たせない)。
 * @param {Array<{key:string,text:string}>} passages
 * @param {object} opt {settings, cache, force, signal}
 * @returns {Promise<{model:string, errors:number}>}
 */
export async function translatePassages(passages, { settings, cache, force = false, signal, onRow } = {}) {
  const cfg = { ...DEFAULT_TRANSLATION, ...(settings || {}) };
  const model = await resolveModel(cfg);
  if (!model) { const e = new Error('NO_MODEL'); e.code = 'NO_MODEL'; throw e; }

  const system = systemPrompt(cfg);
  const pair = langPair(cfg);
  const pending = [];
  passages.forEach((p, i) => {
    const key = cacheKey(model, pair, p.text);
    const hit = force ? null : cache?.get(key);
    if (hit) { onRow?.(i, { state: 'done', text: hit, cached: true }); return; }
    pending.push({ ...p, index: i, key });
  });

  let errors = 0;
  const conc = Math.min(8, Math.max(1, Math.trunc(cfg.concurrency) || 2));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) return;
      const job = pending[cursor++];
      onRow?.(job.index, { state: 'running' });
      const context = cfg.useContext && job.index > 0 ? passages[job.index - 1].text : '';
      try {
        const raw = await api.lmChat(
          cfg.baseURL, model, system, userPrompt(job.text, context), cfg.temperature, cfg.disableThinking,
          { apiKey: cfg.apiKey, prefillThink: cfg.prefillThinkClose },
        );
        const text = cleanCompletion(raw);
        if (!text) throw new Error('empty');
        cache?.set(job.key, text);
        onRow?.(job.index, { state: 'done', text });
      } catch (err) {
        errors++;
        onRow?.(job.index, { state: 'error', error: errorCode(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return { model, errors, requested: pending.length };
}

/**
 * エラーを UI が案内文に置き換えられるコードへ畳む。
 * THINKING_ONLY = 推論モデルが思考に max_tokens を使い切り、訳文が返らなかった。
 */
export function errorCode(err) {
  const s = String(err?.message || err || '');
  if (s.includes('THINKING_ONLY')) return 'THINKING_ONLY';
  if (s.includes('EMPTY_COMPLETION') || s === 'empty') return 'EMPTY_COMPLETION';
  return s;
}

let lastModel = '';
/** モデルを決める: 設定値 → 前回使ったモデル → /v1/models の先頭。 */
export async function resolveModel(cfg) {
  if (cfg.model) { lastModel = cfg.model; return cfg.model; }
  if (lastModel) return lastModel;
  try {
    const ids = await api.lmModels(cfg.baseURL, cfg.apiKey || '');
    if (ids?.length) { lastModel = ids[0]; return ids[0]; }
  } catch { /* 未接続 */ }
  return '';
}

/** 設定画面から接続を確かめる用。 */
export async function probeModels(baseURL, apiKey = '') {
  return api.lmModels(baseURL, apiKey);
}

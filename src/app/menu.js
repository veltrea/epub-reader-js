// ネイティブメニュー(macOS メニューバー)とフロントの橋渡し。
// Rust 側は独自メニュー項目のクリックを "menu" イベント(payload = 項目 id)で投げるだけで、
// 実処理はこちらの actions 表が持つ。項目の文言・有効無効・チェックは Rust が
// 言語・文脈・**いま効いている値**(state)から組み立てる。

import { IS_TAURI, syncMenu } from './api.js';

let actions = {};
let listening = false;
let ctxNow = 'shelf';
let langNow = 'auto';
let stateNow = {};

/**
 * id に対する処理を引く。
 * `file.profile.<uuid>` のような可変長の id は、前方一致のハンドラ(末尾 `.`)へ引数付きで渡す。
 *
 * 前方一致は**いちばん長い鍵**を採る。`tts.sleep.` と `tts.sleep.action.` のように
 * 一方がもう一方の接頭辞になる登録があるので、宣言の順番に結果を委ねない。
 */
function resolveAction(id) {
  if (actions[id]) return () => actions[id]();
  let best = null;
  for (const key of Object.keys(actions)) {
    if (!key.endsWith('.') || !id.startsWith(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? () => actions[best](id.slice(best.length)) : null;
}

/**
 * メニュー項目の実処理を登録し、言語・文脈・状態をネイティブ側へ反映する。
 * @param {'shelf'|'reader'} ctx 画面の文脈(リーダー専用項目の有効化に使う)
 * @param {Record<string, (arg?: string) => any>} table 項目 id → 処理(末尾 `.` は前方一致)
 * @param {string} lang 設定の言語('auto'|'ja'|'en')
 * @param {object} [state] チェックマーク・有効無効に使う「いま効いている値」
 */
export async function setupMenu(ctx, table, lang, state = {}) {
  actions = table || {};
  ctxNow = ctx;
  langNow = lang;
  stateNow = state || {};
  if (!IS_TAURI) return;

  if (!listening) {
    const listen = globalThis.window?.__TAURI__?.event?.listen;
    if (listen) {
      listening = true;
      listen('menu', ({ payload }) => {
        const fn = resolveAction(payload);
        if (!fn) return; // その画面に無い項目(通常は Rust 側で無効化済み)
        Promise.resolve()
          .then(fn)
          .catch((e) => console.error('menu action failed:', payload, e));
      });
    }
  }
  await syncMenu(lang, ctx, stateNow).catch(() => { /* メニュー未対応環境では無視 */ });
}

/**
 * メニューを組み直す。言語が変わったとき、および**チェックの付く値が変わったとき**に呼ぶ。
 * 引数を省くと直前の値を使う(値だけ更新したいときは state だけ渡せばよい)。
 */
export async function refreshMenu(ctx = ctxNow, lang = langNow, state = null) {
  ctxNow = ctx;
  langNow = lang;
  if (state) stateNow = state;
  if (!IS_TAURI) return;
  await syncMenu(langNow, ctxNow, stateNow).catch(() => { /* noop */ });
}

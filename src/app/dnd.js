// ウィンドウへの OS ファイル D&D 取り込み。
// Tauri は dragDropEnabled(既定 true)のとき HTML5 の drop を横取りし、
// 代わりに tauri://drag-enter / drag-over / drag-drop / drag-leave を発火する。
// なので DOM の 'drop' ではなくこのイベントで .epub パスを受け取る。
import { IS_TAURI } from './api.js';
import { t } from './i18n.js';

let overlayEl = null;
function ensureOverlay() {
  if (overlayEl) return overlayEl;
  const el = document.createElement('div');
  el.id = 'dnd-overlay';
  el.style.cssText = `position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;
    background:rgba(59,91,219,.18);border:3px dashed var(--accent,#3b5bdb);
    font:600 1.1rem system-ui;color:var(--fg,#222);pointer-events:none;backdrop-filter:blur(1px);`;
  el.textContent = t('shelf.dropHere');
  document.body.appendChild(el);
  overlayEl = el;
  return el;
}
function showOverlay(v) { ensureOverlay().style.display = v ? 'flex' : 'none'; }

/**
 * D&D を有効化。onEpubs(paths) が**落とされたパスそのまま**で呼ばれる。
 *
 * .epub かどうかの選り分けはここでしない——フォルダを落として中の本をまとめて取り込めるよう、
 * 展開(`expand_book_paths`)を呼び出し側に任せる。ここで拡張子で弾くとフォルダが消える。
 * 返り値は解除関数。非 Tauri では何もしない。
 */
export function enableFileDrop(onEpubs) {
  if (!IS_TAURI || !window.__TAURI__?.event?.listen) return () => {};
  const ev = window.__TAURI__.event;
  const unsubs = [];

  ev.listen('tauri://drag-enter', () => showOverlay(true)).then((u) => unsubs.push(u));
  ev.listen('tauri://drag-over', () => showOverlay(true)).then((u) => unsubs.push(u));
  ev.listen('tauri://drag-leave', () => showOverlay(false)).then((u) => unsubs.push(u));
  ev.listen('tauri://drag-drop', async (e) => {
    showOverlay(false);
    const paths = e.payload?.paths || [];
    if (paths.length) await onEpubs(paths);
  }).then((u) => unsubs.push(u));

  return () => { for (const u of unsubs) try { u(); } catch { /* noop */ } };
}

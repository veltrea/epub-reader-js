// 本棚(ライブラリ)画面。EPUB の取り込み・一覧・五十音分類・分類(コレクション)・書棚の切り替え。
import * as api from './api.js';
import {
  loadLibrary, saveLibrary, saveLibraryNow, flushLibrary,
  loadSettings, saveSettings,
  loadProfiles, switchProfile, addProfile, renameProfile, removeProfile, canRemoveProfile,
  loadCollections, saveCollections, loadShelfScope, saveShelfScope, loadLastRead,
} from './store.js';
import * as col from './collections.js';
import { PRIMARY_ID } from './profiles.js';
import { gojuonSection, GOJUON_ORDER } from './kana.js';
import { loadLocale, t, applyTranslations } from './i18n.js';
import { openSettings, openDict, applyTheme, promptNumber } from './ui-modals.js';
import { PRESET_MINUTES } from './sleeptimer.js';
import { createSharedSleepTimer, systemPower } from './timers.js';
import { enableFileDrop } from './dnd.js';
import { registerTestbus, startTestbus } from './testbus.js';
import { setupMenu, refreshMenu } from './menu.js';

const $ = (s, r = document) => r.querySelector(s);

let library = [];
let settings;
let profileIndex = { profiles: [], currentID: '' };
let collections = [];  // [{id, name, parentID, order}]
let scope = col.SCOPE_ALL;
let expanded = new Set(); // サイドバーで開いている分類
let lastRead = null;   // {id, at} 最後に読んだ本(ヒーロー表示用)
let fracs = {};        // id -> 読書進捗(0..1)
let missingIds = null; // 実体(books/<id>.epub)が消えている本。null = 判定していない
let sleepTimer = null; // スリープタイマー(本を閉じても走り続ける。timers.js を参照)

/**
 * 読了率。**0% と表示すると「未読」と誤読される**ので、僅かでも読んだら 1% にする(§3.1)。
 * @returns {?number} 1…100 / 未読なら null
 */
function progressPercent(id) {
  const f = fracs[id] || 0;
  if (!(f > 0)) return null;
  return Math.min(100, Math.max(1, Math.round(f * 100)));
}

// ---- foliate の languageMap(string | {lang:value}) を文字列へ ----
function lm(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    if (typeof x.name === 'string' || (x.name && typeof x.name === 'object')) return lm(x.name);
    return Object.values(x)[0] ?? '';
  }
  return String(x);
}

// 著者は string | {name} | 配列 のいずれもありうる(foliate は単一著者を string に畳む)。
function authorsToString(a) {
  if (!a) return '';
  const arr = Array.isArray(a) ? a : [a];
  return arr.map((x) => lm(typeof x === 'object' && 'name' in x ? x.name : x)).filter(Boolean).join(', ');
}
function firstSortAs(a) {
  if (!a) return '';
  const arr = Array.isArray(a) ? a : [a];
  for (const x of arr) { const s = lm(x?.sortAs); if (s) return s; }
  return '';
}

// 読みが「かな」だけで構成されているか(§3.1)。
// opf:file-as は漢字のままのことも多く、そのまま五十音分類に使うと「他」へ落ちる。
function isKanaString(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  for (const ch of t) {
    const u = ch.codePointAt(0);
    const ok = (u >= 0x3041 && u <= 0x3096)   // ひらがな
      || (u >= 0x30a1 && u <= 0x30fa)         // カタカナ
      || u === 0x30fc || u === 0x30fb         // ー ・
      || u === 0x3000 || u === 0x20;          // 全角/半角空白
    if (!ok) return false;
  }
  return true;
}

/** 五十音分類に使う読み: 手入力 → sortAs(かなのときだけ) → なし。 */
export function resolvedAuthorReading(b) {
  if (b?.yomi?.trim()) return b.yomi.trim();
  if (isKanaString(b?.authorSort)) return b.authorSort.trim();
  return '';
}

/**
 * 期限付きで待つ。**取り込みを1冊で止めないための保険**——本によっては、絵を描く処理の
 * 約束が返ってこないことがある(大きい固定レイアウトの EPUB で起きる)。待ち続けると
 * 書棚への登録が丸ごと固まる。
 * 期限切れは例外にして、その本を「表紙なし」または「失敗」として先へ進める。
 */
function withDeadline(promise, ms, label) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms); }),
  ]);
}
const OPEN_DEADLINE_MS = 60000;   // 中身を開く(大きな FXL は数十秒かかることがある)
const COVER_DEADLINE_MS = 20000;  // 表紙1枚を描く

// ---- EPUB からメタデータ + 表紙を抽出 ----
async function extractMeta(file) {
  importStage = 'meta:import-view';
  const { makeBook } = await import('../foliate-js/view.js');
  importStage = 'meta:makeBook';
  const book = await withDeadline(makeBook(file), OPEN_DEADLINE_MS, 'makeBook');
  importStage = 'meta:metadata';
  const md = book.metadata || {};
  const title = lm(md.title) || file.name?.replace(/\.epub$/i, '') || '無題';
  const author = authorsToString(md.author);
  const publisher = lm(md.publisher) || '';
  // 作者の読み(五十音「作者別」分類・作者ソート用)。opf:file-as / contributor.sortAs。
  const authorSort = firstSortAs(md.author) || lm(md.sortAs) || '';
  const yomi = isKanaString(authorSort) ? authorSort : '';
  importStage = 'meta:getCover';
  // 表紙は**あれば嬉しい**もの。取れなくても本は登録する(期限切れ・例外とも黙って諦める)。
  const cover = await withDeadline(coverOf(book), COVER_DEADLINE_MS, 'cover').catch(() => null);
  importStage = 'meta:destroy';
  // **必ず待って閉じる**——本を開くと、そのぶんの資源を抱えたままになる。閉じ終わる前に
  // 次を開き続けると、何冊目かで描画の約束が返らなくなり、表紙が取れない本が並ぶ。
  try { await withDeadline(book.destroy?.(), 5000, 'destroy'); } catch { /* noop */ }
  importStage = 'meta:done';
  return { title, author, publisher, yomi, authorSort, cover };
}

/** 表紙を1枚取り出して縮小まで済ませる。取れなければ null。 */
async function coverOf(book) {
  try {
    const blob = await book.getCover?.();
    if (blob) return await downscaleCover(blob);
  } catch { /* 表紙なしは許容 */ }
  // getCover() は manifest の cover-image / EPUB2 の meta[name=cover] / guide しか見ない。
  // OMF 漫画はそのどれも持たないことがあるので、spine 先頭から絵を拾う(§6)。
  try {
    const blob = await coverFromFirstSection(book);
    if (blob) return await downscaleCover(blob);
  } catch { /* noop */ }
  return null;
}

/**
 * spine の先頭から表紙の絵を取り出す。
 * 先頭 section が画像そのものならそれを、XHTML なら中の最初の img/image を fetch する。
 */
async function coverFromFirstSection(book) {
  const first = book?.sections?.[0];
  if (!first?.load) return null;
  const url = await first.load();
  if (!url) return null;
  const res = await fetch(url);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) return await res.blob();
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, type.includes('xml') ? 'application/xhtml+xml' : 'text/html');
  const el = doc.querySelector('img, image');
  const src = el?.getAttribute('src') || el?.getAttribute('xlink:href')
    || el?.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href');
  if (!src) return null;
  const abs = new URL(src, url).href;
  const r2 = await fetch(abs);
  if (!r2.ok) return null;
  return await r2.blob();
}

// 表紙は最大幅240pxに縮小して保存(library.json 肥大化を防ぐ)。
async function downscaleCover(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const maxW = 240;
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    // 変換失敗時はそのまま dataURL 化
    return await blobToDataURL(blob);
  }
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// 取り込み(1冊ずつ・フォルダまるごと)
// ---------------------------------------------------------------------------

/**
 * 取り込みの進み具合。フォルダをまとめて登録している間、書棚の上に帯で出す。
 * 画面の操作は塞がない(何十冊もの登録を待つあいだ読書ができないのは困る)。
 */
let importProgress = null;   // {done, total, added, skipped, failed, current}
let importCancelled = false;
let importReportTimer = null;
// 最後に落ちた取り込みの理由。画面には出さない(§作家向けプレビュー)——テストバスから
// 「なぜ 1 冊 failed になったのか」を外から確かめるためだけに持つ。
let lastImportError = null;
let importStage = '';   // 診断用: どの段で止まっているか(read/meta/cover/copy/done)

function showImportBanner() {
  const el = $('#import-banner');
  if (!el) return;
  if (!importProgress) { el.hidden = true; return; }
  const p = importProgress;
  el.hidden = false;
  $('#ib-progress').value = p.total ? p.done / p.total : 0;
  $('#ib-title').textContent = t('shelf.importing', { done: p.done, total: p.total });
  $('#ib-current').textContent = p.current || '';
  $('#ib-cancel').hidden = false;
}

/** 終わったときの短い報告。数秒で自分から消える。 */
function reportImport(p, cancelled) {
  const el = $('#import-banner');
  if (!el) return;
  const notes = [];
  if (p.skipped) notes.push(t('shelf.importSkipped', { n: p.skipped }));
  if (p.failed) notes.push(t('shelf.importFailed', { n: p.failed }));
  const head = cancelled
    ? t('shelf.importCanceled', { added: p.added })
    : (p.total === 0 ? t('shelf.importNone') : t('shelf.importDone', { added: p.added }));
  el.hidden = false;
  $('#ib-progress').value = 1;
  $('#ib-title').textContent = head;
  $('#ib-current').textContent = notes.join(' / ');
  $('#ib-cancel').hidden = true;
  clearTimeout(importReportTimer);
  importReportTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/** 既に同じファイルから取り込んだ本か(パスで見る)。 */
function alreadyRegistered(path) {
  return library.some((b) => b.sourcePath && b.sourcePath === path);
}

/**
 * リーダーで落とされた本を取り込む。**1 冊だけなら、取り込んだあとその本を開く。**
 * 読んでいる最中に本を落とす人は、その本を読みたいはずなので、書棚で止めない。
 *
 * フォルダや複数のファイルのときは書棚に留まる。どれを開けばよいか決められないため。
 * 既に取り込んである本を落としたときも開く（取り込みは飛ばされるが、蔵書の中に見つかる）。
 */
async function importDroppedFromReader(paths) {
  const expandedPaths = await api.expandBookPaths(paths);
  await importFromPaths(expandedPaths);
  if (expandedPaths.length !== 1) return;
  const book = library.find((b) => b.sourcePath === expandedPaths[0]);
  if (!book) return;   // 取り込みに失敗した。書棚に留まって帯の失敗表示を見せる
  await flushLibrary();
  location.href = `reader.html?id=${encodeURIComponent(book.id)}`;
}

/**
 * パスの並びを順に取り込む。フォルダは api 側(Rust)で EPUB の並びへ展開済みであること。
 * @param {string[]} paths
 * @param {{announce?: boolean}} [opts] announce=false なら帯を出さない(初回シードなど)
 */
async function importFromPaths(paths, { announce = true } = {}) {
  if (!paths?.length) {
    if (announce) reportImport({ done: 0, total: 0, added: 0, skipped: 0, failed: 0 }, false);
    return;
  }
  importCancelled = false;
  const p = { done: 0, total: paths.length, added: 0, skipped: 0, failed: 0, current: '' };
  importProgress = announce ? p : null;
  showImportBanner();
  for (const path of paths) {
    if (importCancelled) break;
    p.current = path.split('/').pop() || path;
    showImportBanner();
    if (alreadyRegistered(path)) {
      p.skipped++;
    } else {
      try {
        importStage = 'read';
        const b64 = await api.readFileB64(path);
        const file = new File([api.blobFromB64(b64)], p.current);
        importStage = 'meta';
        const meta = await extractMeta(file);
        const id = crypto.randomUUID();
        importStage = 'copy';
        await api.importBook(path, id);
        importStage = 'done';
        library.push({ id, ...meta, sourcePath: path, addedAt: Date.now(), progress: 0 });
        p.added++;
      } catch (e) {
        console.error('import failed', path, e);
        lastImportError = { path, message: String(e?.message || e), stack: String(e?.stack || '') };
        p.failed++;
      }
    }
    p.done++;
    showImportBanner();
    // 1冊ごとに手を離して書棚を固まらせない(何百冊でも操作を受け付ける)。
    await new Promise((r) => setTimeout(r, 0));
  }
  await saveLibraryNow(library);
  importProgress = null;
  if (announce) reportImport(p, importCancelled);
  render();
}

function cancelImport() {
  importCancelled = true;
}

// ブラウザ検証用(File 入力から取り込み。id をファイル名にして test-books を参照)
async function importFromFiles(files) {
  for (const file of files) {
    try {
      const meta = await extractMeta(file);
      const id = crypto.randomUUID();
      library.push({ id, ...meta, addedAt: Date.now(), progress: 0, _file: file });
      // ブラウザではバイトを保持できないので Blob URL を持たせる
      const url = URL.createObjectURL(file);
      sessionStorage.setItem('bookurl:' + id, url);
    } catch (e) { console.error(e); }
  }
  await saveLibraryNow(library.map(({ _file, ...b }) => b));
  render();
}

/**
 * 同梱サンプルを初回だけ書棚に登録(すぐ試せるように)。
 * **増やした書棚は空のままにする**——人へ見せるために作った書棚に、頼んでいない本を入れない。
 */
async function seedSampleIfNeeded() {
  if (!api.IS_TAURI) return;
  if (profileIndex.currentID !== PRIMARY_ID) return;
  if (library.length) return;
  if (settings.seeded) return;
  settings.seeded = true;
  await saveSettings(settings);
  // バンドルに同梱しているサンプル。無ければ何もしない(配布形態によっては入っていない)。
  const names = ['sample-vertical.epub'];
  let added = 0;
  for (const n of names) {
    try {
      const res = await fetch(new URL('../samples/' + n, import.meta.url));
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const id = crypto.randomUUID();
      const meta = await extractMeta(new File([buf], n));
      // 同梱ファイルは元パスを持てないので、バイト列を直接 books/<id>.epub へ書き込む。
      await api.importBookBytes(id, api.b64FromArrayBuffer(buf), n.split('.').pop());
      library.push({ id, ...meta, addedAt: Date.now(), progress: 0 });
      added++;
    } catch { /* サンプルが無くても書棚は成立する */ }
  }
  if (added) { await saveLibraryNow(library); render(); }
}

// ---- フィルタ + 並び替え ----
let filterText = '';

/** スコープ(すべて/お気に入り/未分類/分類)で絞った本。 */
function scopedBooks() {
  return col.booksInScope(library, scope, collections);
}

// フィルタのみ適用(ソートなし)。対象項目は field(all/title/author/publisher)。
function filteredBooks() {
  const base = scopedBooks();
  const q = filterText.trim().toLowerCase();
  if (!q) return base;
  const field = settings.filterField || 'all';
  const hit = (s) => (s || '').toLowerCase().includes(q);
  return base.filter((b) => {
    if (field === 'title') return hit(b.title);
    if (field === 'author') return hit(b.author);
    if (field === 'publisher') return hit(b.publisher);
    return hit(b.title) || hit(b.author) || hit(b.publisher);
  });
}

// フィルタ→ソート(グリッド用)。recent は addedAt 降順、他は localeCompare(ja)。
function visibleBooks() {
  const arr = filteredBooks();
  const key = settings.sortKey || 'recent';
  const cmp = (x, y) => x.localeCompare(y, 'ja', { numeric: true });
  const sorted = [...arr];
  if (key === 'title') sorted.sort((a, b) => cmp(a.title || '', b.title || ''));
  else if (key === 'author') sorted.sort((a, b) => cmp(a.author || '', b.author || ''));
  else if (key === 'publisher') sorted.sort((a, b) => cmp(a.publisher || '', b.publisher || ''));
  else sorted.sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0)); // recent(最近開いた)
  return sorted;
}

// ---------------------------------------------------------------------------
// 描画
// ---------------------------------------------------------------------------
// 見た目の基準は Swift 版 ShelfView.swift。寸法はそちらの実数をそのまま CSS へ写してある。

/** SF Symbols に相当する線画。Swift 版が使っている記号と同じ絵柄にそろえる。 */
const SYM = {
  // books.vertical / star.fill / tray / folder / folder.badge.plus
  books: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4" width="4.4" height="16" rx="1.2"/><rect x="9.2" y="4" width="4.4" height="16" rx="1.2"/><path d="M16.4 5.6l3.4-.9 2 15-3.4.9z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.2l2.7 5.6 6 .9-4.4 4.3 1.1 6.1L12 17.2 6.6 20.1l1.1-6.1L3.3 9.7l6-.9z"/></svg>',
  tray: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.2 14.2h4.3l1.3 2.2h6.4l1.3-2.2h4.3"/><path d="M3.2 14.2L6 5.6h12l2.8 8.6v3.4a1.6 1.6 0 0 1-1.6 1.6H4.8a1.6 1.6 0 0 1-1.6-1.6z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h4.1l1.8 2.2h8.7A1.7 1.7 0 0 1 21 9.4v7.4a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 16.8z"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 7.2A1.7 1.7 0 0 1 4.7 5.5h4.1l1.8 2.2h8.7A1.7 1.7 0 0 1 21 9.4v7.4a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 16.8z"/><path d="M12 11.4v4.6M9.7 13.7h4.6" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.4l9.6 16.6H2.4z"/><path d="M12 9.4v5M12 16.6v.9" stroke="#1a1a1c" stroke-width="1.8" stroke-linecap="round"/></svg>',
  magnifier: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="6.6"/><path d="M15.4 15.4L21 21"/></svg>',
};

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function render() {
  renderSidebar();
  renderHeader();
  const shelf = $('#shelf');
  shelf.innerHTML = '';
  updateAmbient(heroBook());

  if (!library.length) { shelf.appendChild(emptyState()); return; }
  if (!filteredBooks().length) { shelf.appendChild(noMatchState()); return; }

  const hero = heroCard();
  if (hero) shelf.appendChild(hero);

  if ((settings.shelfView || 'grid') === 'gojuon') {
    // 作者別: 作者の読みでセクション化。section 内は 作者読み→タイトル 順(Swift版準拠)。
    const cmp = (x, y) => (x || '').localeCompare(y || '', 'ja', { numeric: true });
    const groups = new Map();
    for (const b of filteredBooks()) {
      // 作者読み→作者名(漢字は「他」)→無しは「—」。Swift の authorSortKey 相当。
      const sec = gojuonSection(resolvedAuthorReading(b) || b.author || '', '');
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push(b);
    }
    for (const sec of GOJUON_ORDER) {
      const items = groups.get(sec);
      if (!items) continue;
      items.sort((a, b) => cmp(resolvedAuthorReading(a) || a.author, resolvedAuthorReading(b) || b.author) || cmp(a.title, b.title));
      const head = el('div', 'section-head');
      head.textContent = sec === '他' ? t('shelf.section.other') : sec;
      shelf.appendChild(head);
      const grid = el('div', 'grid section-grid');
      for (const b of items) grid.appendChild(bookCard(b));
      shelf.appendChild(grid);
    }
    return;
  }

  const grid = el('div', 'grid');
  for (const b of visibleBooks()) grid.appendChild(bookCard(b));
  shelf.appendChild(grid);
}

/** ヘッダ(いま見ている棚の名前・冊数・並び替えのラベル)。 */
function renderHeader() {
  $('#scope-title').textContent = scopeTitle();
  $('#scope-count').textContent = t('shelf.bookCount', { n: filteredBooks().length });
  $('#sort-label').textContent = t('shelf.sortLabel', { key: t('shelf.sort.' + (settings.sortKey || 'recent')) });
  // 作者別は五十音順で並ぶので、並び替えはグリッドのときだけ出す(Swift 版と同じ)。
  $('#sort-btn').hidden = (settings.shelfView || 'grid') !== 'grid';
  for (const b of document.querySelectorAll('#view-seg button')) {
    b.classList.toggle('on', b.dataset.view === (settings.shelfView || 'grid'));
  }
  $('#filter-clear').hidden = !filterText;
}

/** ヘッダに出す、いま見ている棚の名前。 */
function scopeTitle() {
  if (scope === col.SCOPE_FAVORITES) return t('shelf.scope.favorites');
  if (scope === col.SCOPE_UNFILED) return t('shelf.scope.unfiled');
  const cid = col.collectionOfScope(scope);
  const c = cid && collections.find((x) => x.id === cid);
  return c ? c.name : t('shelf.title');
}

function emptyState() {
  const e = el('div', 'empty');
  e.innerHTML = `<div class="sym">${SYM.books}</div>
    <div class="head">${escapeHtml(t('shelf.emptyHead'))}</div>
    <div class="sub">${escapeHtml(t('shelf.emptySub'))}</div>
    <div class="sub">${escapeHtml(t('shelf.emptySub2'))}</div>`;
  return e;
}

function noMatchState() {
  const e = el('div', 'empty');
  e.innerHTML = `<div class="sym">${SYM.magnifier}</div>
    <div class="head">${escapeHtml(t('shelf.noMatch'))}</div>
    <div class="sub">${escapeHtml(filterText ? t('shelf.noMatchFilter') : t('shelf.noMatchScope'))}</div>`;
  return e;
}

// ---------------------------------------------------------------------------
// サイドバー(スコープと分類)
// ---------------------------------------------------------------------------

function renderSidebar() {
  const nav = $('#sidebar');
  if (!nav) return;
  const counts = col.shelfCounts(library, collections);
  nav.innerHTML = '';

  // 「書棚」— 固定の棚(すべての本 / お気に入り / 未分類)
  nav.appendChild(sectionHead(t('shelf.section.shelf'), null));
  nav.appendChild(scopeRow(col.SCOPE_ALL, t('shelf.scope.allBooks'), counts[col.SCOPE_ALL] || 0, 0, false, SYM.books));
  nav.appendChild(scopeRow(col.SCOPE_FAVORITES, t('shelf.scope.favorites'), counts[col.SCOPE_FAVORITES] || 0, 0, false, SYM.star));
  nav.appendChild(scopeRow(col.SCOPE_UNFILED, t('shelf.scope.unfiled'), counts[col.SCOPE_UNFILED] || 0, 0, false, SYM.tray));

  // 「分類」— 入れ子にできる分類 + 「新しい分類…」
  nav.appendChild(sectionHead(t('shelf.collections'), () => promptNewCollection(null)));
  for (const r of col.rows(collections, expanded)) {
    const sc = 'collection:' + r.collection.id;
    nav.appendChild(scopeRow(sc, r.collection.name, counts[sc] || 0, r.depth, r.hasChildren, SYM.folder, r.collection));
  }
  const add = el('button', 'side-row muted');
  add.innerHTML = `<span class="twist hidden"></span><span class="sym">${SYM.folderPlus}</span>
    <span class="label"></span>`;
  add.querySelector('.label').textContent = t('shelf.collectionNewRow');
  add.addEventListener('click', () => promptNewCollection(null));
  nav.appendChild(add);

  // 「書棚を切り替える」はメニューバー（ファイル）と管理シートが持つ。サイドバーは
  // Swift 版と同じく分類だけを並べる。
}

function sectionHead(title, onAdd) {
  const h = el('div', 'sidebar-section');
  h.innerHTML = `<span class="grow"></span>`;
  h.querySelector('.grow').textContent = title;
  if (onAdd) {
    const b = el('button', 'icon plain', SYM.plus);
    b.title = t('shelf.collectionNew');
    b.addEventListener('click', onAdd);
    h.appendChild(b);
  }
  return h;
}

function scopeRow(sc, label, count, depth, hasChildren, symbol, collection = null) {
  const row = el('button', 'side-row' + (sc === scope ? ' on' : ''));
  row.dataset.scope = sc;
  row.style.paddingInlineStart = (8 + depth * 14) + 'px';
  row.innerHTML = `<span class="twist${hasChildren ? '' : ' hidden'}">${SYM.chevron}</span>
    <span class="sym">${symbol}</span><span class="label"></span><span class="count"></span>`;
  const twist = row.querySelector('.twist');
  if (hasChildren) {
    twist.classList.toggle('open', expanded.has(collection.id));
    twist.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded.has(collection.id)) expanded.delete(collection.id);
      else expanded.add(collection.id);
      renderSidebar();
    });
  }
  row.querySelector('.label').textContent = label;
  row.querySelector('.count').textContent = count ? String(count) : '';
  row.addEventListener('click', () => setScope(sc));
  if (collection) {
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); openCollectionMenu(e, collection); });
    // 本をここへ落として分類に入れる
    row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      const id = e.dataTransfer?.getData('text/book-id');
      if (id) await setMembership(id, collection.id, true);
    });
  }
  return row;
}

async function setScope(sc) {
  scope = col.parseScope(sc);
  await saveShelfScope(scope);
  render();
  return scope;
}

// ---- 分類の操作 ----

async function addCollection(name, parentID = null) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const c = {
    id: crypto.randomUUID(), name: trimmed, parentID: parentID || null,
    order: col.nextOrder(parentID, collections),
  };
  collections = [...collections, c];
  await saveCollections(collections);
  if (parentID) expanded.add(parentID);
  render();
  return c;
}

async function renameCollection(id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  collections = collections.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
  await saveCollections(collections);
  render();
  return true;
}

/** 分類を消す。本は消さず、子の分類は一つ上へ繰り上げる(階層に穴を空けない)。 */
async function removeCollection(id) {
  collections = col.removing(id, collections);
  await saveCollections(collections);
  // 本の側の所属も掃除する(消えた分類の ID を残さない)。
  let changed = false;
  for (const b of library) {
    const list = col.bookCollections(b);
    if (list.includes(id)) { b.collections = list.filter((x) => x !== id); changed = true; }
  }
  if (changed) await saveLibraryNow(library);
  if (col.collectionOfScope(scope) === id) await setScope(col.SCOPE_ALL);
  else render();
  return true;
}

/** 分類の親を付け替える。自分の子孫は親に選べない(循環を作らない)。 */
async function moveCollection(id, newParent) {
  if (newParent && col.isDescendant(newParent, id, collections)) return false;
  collections = collections.map((c) => (c.id === id ? { ...c, parentID: newParent || null } : c));
  await saveCollections(collections);
  if (newParent) expanded.add(newParent);
  render();
  return true;
}

async function setMembership(bookID, collectionID, member) {
  const b = library.find((x) => x.id === bookID);
  if (!b) return false;
  const list = col.bookCollections(b);
  const has = list.includes(collectionID);
  if (has === member) return true;
  b.collections = member ? [...list, collectionID] : list.filter((x) => x !== collectionID);
  await saveLibraryNow(library);
  render();
  return true;
}

async function setFavorite(bookID, on) {
  const b = library.find((x) => x.id === bookID);
  if (!b) return false;
  b.favorite = !!on;
  await saveLibraryNow(library);
  render();
  return true;
}

// ---------------------------------------------------------------------------
// 本の並び
// ---------------------------------------------------------------------------

/** 最後に読んだ 1 冊。段の主役であり、書棚の地に敷くカバーの持ち主。 */
function heroBook() {
  let best = null;
  for (const b of library) {
    if (!best || (b.lastOpenedAt || 0) > (best.lastOpenedAt || 0)) best = b;
  }
  if (best && !(best.lastOpenedAt || 0) && lastRead) {
    return library.find((x) => x.id === lastRead.id) || best;
  }
  return best;
}

/** 「続きを読む」段に出す本。絞り込み中は、その結果に含まれるときだけ出す。 */
function continueBook() {
  const b = heroBook();
  if (!b) return null;
  return filteredBooks().some((x) => x.id === b.id) ? b : null;
}

// ぼかした表紙を書棚全体の地に敷く。地に使う本は**絞り込みに左右されない**
// (フィルタのたびに地が入れ替わると落ち着かない)。
function updateAmbient(b) {
  const amb = $('#ambient');
  if (!amb) return;
  if (!b?.cover) { amb.hidden = true; return; }
  amb.hidden = false;
  amb.querySelector('.amb-img').style.backgroundImage = `url('${b.cover}')`;
}

/** 表紙。無い本には装丁を模した代替表紙を描き、その上にタイトルを重ねる。 */
function coverHTML(b) {
  if (b.cover) return `<img src="${b.cover}" alt="">`;
  return `<div class="ph"><div class="ph-title">${escapeHtml(b.title)}</div></div>`;
}

function heroCard() {
  const b = continueBook();
  if (!b) return null;
  const pct = progressPercent(b.id);
  const missing = missingIds && missingIds.has(b.id);
  const e = el('section');
  e.id = 'hero';
  e.innerHTML = `
    <div class="hero-cover">${coverHTML(b)}</div>
    <div class="hero-info">
      <div class="hero-title">${escapeHtml(b.title)}</div>
      ${b.author ? `<div class="hero-author">${escapeHtml(b.author)}</div>` : ''}
      ${pct ? `<div class="hero-progress">${t('shelf.readPct').replace('{n}', pct)}</div>` : ''}
      <button class="primary hero-continue"${missing ? ' disabled' : ''}>${
        escapeHtml(b.lastOpenedAt || pct ? t('shelf.continue') : t('shelf.start'))}</button>
      ${missing ? `<div class="hero-progress" style="color:var(--tint-orange)">${escapeHtml(t('shelf.fileMissing'))}</div>` : ''}
    </div>`;
  e.addEventListener('click', (ev) => { if (!missing && !ev.target.closest('button')) openBook(b); });
  e.querySelector('.hero-continue').addEventListener('click', () => { if (!missing) openBook(b); });
  return e;
}

function bookCard(b) {
  const e = el('div', 'book');
  e.dataset.id = b.id;
  const pct = progressPercent(b.id);
  const missing = missingIds && missingIds.has(b.id);
  e.innerHTML = `
    <div class="cover">
      ${coverHTML(b)}
      ${col.isFavorite(b) ? `<span class="fav" title="${escapeHtml(t('shelf.unfavorite'))}">${SYM.star}</span>` : ''}
      ${missing ? `<span class="missing" title="${escapeHtml(t('shelf.fileMissing'))}">${SYM.warn}</span>` : ''}
      ${pct ? `<span class="prog">${pct}%</span>` : ''}
    </div>
    <div class="title">${escapeHtml(b.title)}</div>
    <div class="author">${escapeHtml(b.author || '')}</div>`;
  e.addEventListener('click', () => openBook(b));
  e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openBookMenu(ev, b); });
  // サイドバーの分類へドラッグして入れる
  e.draggable = true;
  e.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/book-id', b.id);
    ev.dataTransfer.effectAllowed = 'copy';
    e.classList.add('dragging');
  });
  e.addEventListener('dragend', () => e.classList.remove('dragging'));
  return e;
}

async function removeBook(id) {
  await api.deleteBook(id);
  library = library.filter((x) => x.id !== id);
  await saveLibraryNow(library);
  render();
}

async function openBook(b) {
  b.lastOpenedAt = Date.now();
  try { await saveLibraryNow(library); } catch { /* 保存に失敗しても開く */ }
  location.href = `reader.html?id=${encodeURIComponent(b.id)}`;
}

// ---------------------------------------------------------------------------
// 右クリックメニュー
// ---------------------------------------------------------------------------

function openMenu(e, items) {
  const menu = $('#ctxmenu');
  menu.innerHTML = '';
  for (const it of items) {
    if (it === '-') { menu.appendChild(el('div', 'sep')); continue; }
    if (it.head) { const h = el('div', 'head'); h.textContent = it.head; menu.appendChild(h); continue; }
    const b = el('button', it.danger ? 'danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', async () => { closeMenu(); await it.run(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  // 画面外へはみ出さないよう、右下は内側へ寄せる
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - h - 8) + 'px';
}

function closeMenu() { $('#ctxmenu').hidden = true; }

function openBookMenu(e, b) {
  const inList = col.bookCollections(b);
  const items = [
    col.isFavorite(b)
      ? { label: t('shelf.unfavorite'), run: () => setFavorite(b.id, false) }
      : { label: t('shelf.favorite'), run: () => setFavorite(b.id, true) },
    '-',
    { head: t('shelf.collections') },
  ];
  if (!collections.length) {
    items.push({ label: t('shelf.noCollections'), run: () => {} });
  } else {
    for (const r of col.rows(collections, new Set(collections.map((c) => c.id)))) {
      const inside = inList.includes(r.collection.id);
      items.push({
        label: '　'.repeat(r.depth) + (inside ? '✓ ' : '　') + r.collection.name,
        run: () => setMembership(b.id, r.collection.id, !inside),
      });
    }
  }
  items.push({ label: t('shelf.collectionNewWith'), run: () => promptNewCollection(null, b.id) });
  items.push('-');
  items.push({ label: t('shelf.editYomi'), run: () => editYomi(b) });
  items.push('-');
  items.push({ label: t('shelf.delete'), danger: true, run: async () => { if (confirm(t('shelf.deleteConfirm'))) await removeBook(b.id); } });
  openMenu(e, items);
}

function openCollectionMenu(e, c) {
  const items = [
    { label: t('shelf.collectionRename'), run: async () => {
      const name = await promptText(t('shelf.collectionRename'), t('shelf.collectionName'), c.name);
      if (name) await renameCollection(c.id, name);
    } },
    { label: t('shelf.collectionSub'), run: () => promptNewCollection(c.id) },
  ];
  if (c.parentID) items.push({ label: t('shelf.collectionToRoot'), run: () => moveCollection(c.id, null) });
  // 自分自身と自分の子孫は親に選べない(循環を作らない)。
  const targets = collections.filter((o) => !col.isDescendant(o.id, c.id, collections));
  if (targets.length) {
    items.push({ head: t('shelf.collectionMove') });
    for (const o of targets) items.push({ label: col.pathName(o.id, collections), run: () => moveCollection(c.id, o.id) });
  }
  items.push('-');
  items.push({ label: t('shelf.collectionRemove'), danger: true, run: async () => {
    if (confirm(t('shelf.collectionRemoveConfirm'))) await removeCollection(c.id);
  } });
  openMenu(e, items);
}

async function promptNewCollection(parentID, bookID = null) {
  const name = await promptText(
    parentID ? t('shelf.collectionSub') : t('shelf.collectionNew'), t('shelf.collectionName'), '');
  if (!name) return;
  const c = await addCollection(name, parentID);
  if (c && bookID) await setMembership(bookID, c.id, true);
}

// ---------------------------------------------------------------------------
// 書棚(プロファイル)
// ---------------------------------------------------------------------------

async function doSwitchProfile(id) {
  if (id === profileIndex.currentID) return profileIndex.currentID;
  // 走っているものを降ろす。取り込みが特に大事で、続けさせると
  // **切り替えた先の書棚へ前の書棚の本が入る**。
  cancelImport();
  await flushLibrary();
  profileIndex = await switchProfile(profileIndex, id);
  await reloadShelfData();
  render();
  await syncMenuState();
  // 書棚が空になったのを「蔵書が消えた」と誤解しないよう、切り替えたことを知らせる。
  notice(t('shelf.profileSwitched', { name: profileIndex.profiles.find((p) => p.id === id)?.name || '' }));
  return profileIndex.currentID;
}

/** 取り込みの帯を短い告知にも使う(数秒で自分から消える)。 */
function notice(text) {
  const el = $('#import-banner');
  if (!el) return;
  el.hidden = false;
  $('#ib-progress').hidden = true;
  $('#ib-title').textContent = text;
  $('#ib-current').textContent = '';
  $('#ib-cancel').hidden = true;
  clearTimeout(importReportTimer);
  importReportTimer = setTimeout(() => { el.hidden = true; $('#ib-progress').hidden = false; }, 4000);
}

/** 新しい書棚を作って、そのまま移る。中身は空(同梱サンプルも入れない)。 */
async function newProfile() {
  const name = await promptText(t('menu.file.newShelf'), t('shelf.profileName'), t('shelf.profileNewPrompt'));
  if (!name) return null;
  const { profile } = await addProfile(profileIndex, name);
  if (!profile) return null;
  profileIndex = await loadProfiles(t('shelf.profilePrimary'));
  await doSwitchProfile(profile.id);
  return profile;
}

/** 書棚に紐づくものを丸ごと読み直す(蔵書・分類・スコープ・読みかけ)。 */
async function reloadShelfData() {
  library = await loadLibrary();
  collections = await loadCollections();
  scope = await loadShelfScope();
  expanded = new Set();
  lastRead = await loadLastRead();
  try {
    const pairs = await Promise.all(library.map(async (b) => [b.id, (await api.storeGet('frac-' + b.id)) || 0]));
    fracs = Object.fromEntries(pairs);
  } catch { fracs = {}; }
  try {
    const present = await api.listBooks();
    missingIds = present ? new Set(library.filter((b) => !present.includes(b.id)).map((b) => b.id)) : null;
  } catch { missingIds = null; }
}

function openProfileManager() {
  const back = el('div', 'modal-backdrop show');
  back.innerHTML = `<div class="modal">
    <div class="sheet-bar">
      <span class="grow" style="font-weight:600;text-align:center">${escapeHtml(t('shelf.profileManage'))}</span>
      <button id="pm-close">${escapeHtml(t('settings.close'))}</button>
    </div>
    <div class="modal-body">
      <div class="group-head">${escapeHtml(t('shelf.profiles'))}</div>
      <div class="group" id="pm-list"></div>
      <div class="desc" style="padding:0 0 14px">${escapeHtml(t('shelf.profileDesc'))}</div>
      <div class="group-head">${escapeHtml(t('shelf.profileNew'))}</div>
      <div class="group"><div class="row">
        <input id="pm-new" class="grow" placeholder="${escapeHtml(t('shelf.profileName'))}">
        <button id="pm-add">${escapeHtml(t('shelf.profileAdd'))}</button>
      </div></div>
      <div class="desc" style="padding:0">${escapeHtml(t('shelf.profileNewDesc'))}</div>
    </div>
  </div>`;
  document.body.appendChild(back);

  const list = back.querySelector('#pm-list');
  const draw = () => {
    list.innerHTML = '';
    for (const p of profileIndex.profiles) {
      const cur = p.id === profileIndex.currentID;
      const row = el('div', 'row');
      row.innerHTML = `<span class="sym" style="width:16px;color:${cur ? 'var(--accent)' : 'var(--muted2)'}">
          ${cur ? '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9.5"/><path d="M7.6 12.2l3 3 5.8-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/></svg>'}
        </span>
        <span class="grow"><span class="pm-name"></span>${cur ? `<div style="font-size:10px;color:var(--muted)">${escapeHtml(t('shelf.profileCurrent'))}</div>` : ''}</span>
        ${cur ? '' : `<button class="pm-switch">${escapeHtml(t('shelf.profileSwitch'))}</button>`}
        <button class="pm-rename">${escapeHtml(t('shelf.profileRename'))}</button>
        <button class="pm-remove danger"${canRemoveProfile(profileIndex, p.id) ? '' : ' disabled'}
          style="color:#ff453a">${escapeHtml(t('shelf.profileRemove'))}</button>`;
      row.querySelector('.pm-name').textContent = p.name;
      row.querySelector('.pm-switch')?.addEventListener('click', async () => { await doSwitchProfile(p.id); draw(); });
      row.querySelector('.pm-rename').addEventListener('click', async () => {
        const name = await promptText(t('shelf.profileRename'), t('shelf.profileName'), p.name);
        if (!name) return;
        ({ index: profileIndex } = await renameProfile(profileIndex, p.id, name));
        draw(); render(); await syncMenuState();
      });
      row.querySelector('.pm-remove').addEventListener('click', async () => {
        if (!confirm(t('shelf.profileRemoveConfirm'))) return;
        ({ index: profileIndex } = await removeProfile(profileIndex, p.id));
        draw(); render(); await syncMenuState();
      });
      list.appendChild(row);
    }
  };
  draw();

  back.querySelector('#pm-add').addEventListener('click', async () => {
    const input = back.querySelector('#pm-new');
    const { profile } = await addProfile(profileIndex, input.value);
    if (!profile) return;
    profileIndex = await loadProfiles(t('shelf.profilePrimary'));
    input.value = '';
    draw(); render(); await syncMenuState();
  });
  const close = () => back.remove();
  back.querySelector('#pm-close').addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
}

// ---- メタデータのバックフィル(§5.7) ----
// 書棚を開いたとき 1 度だけ実行する。probe が落ちた本や、旧バージョンで取り込んだ本は
// 作者・出版社・表紙・読みが丸ごと欠けるので、取得できた項目だけを後から埋める。
async function backfillMetadata() {
  const targets = library.filter((b) => {
    if (missingIds?.has(b.id)) return false;
    // 一度調べた本は再訪のたびに調べ直さない。表紙も作者も本当に持っていない本
    // (自作の検証用 EPUB 等)を毎回開き直すと、書棚が重くなるだけで何も増えない。
    if (b.metaCheckedAt) return false;
    return (!b.author && !b.publisher) || (b.author && b.authorSort === undefined) || !b.cover;
  });
  if (!targets.length) return;
  const status = $('#backfill');
  if (status) { status.hidden = false; status.textContent = t('shelf.backfilling'); }
  let changed = false;
  for (const b of targets) {
    try {
      const { ext, data } = await api.readBook(b.id);
      const file = new File([api.blobFromB64(data)], `${b.id}.${ext || 'epub'}`);
      const meta = await extractMeta(file);
      // タイトルは「ファイル名フォールバックのままのとき」だけ上書きする
      if (meta.title && (!b.title || b.title === b.id)) { b.title = meta.title; changed = true; }
      for (const k of ['author', 'publisher', 'authorSort', 'cover']) {
        if (!b[k] && meta[k]) { b[k] = meta[k]; changed = true; }
      }
      if (!b.yomi && meta.yomi) { b.yomi = meta.yomi; changed = true; }
    } catch (e) {
      console.error('backfill failed', b.id, e);
    }
    b.metaCheckedAt = Date.now();
    changed = true;
    await new Promise((r) => setTimeout(r, 0));  // 1冊ごとに手を離して書棚を固まらせない
  }
  if (status) status.hidden = true;
  if (changed) { await saveLibraryNow(library); render(); }
}

// ---- M1: 本の読み(yomi)を編集(五十音分類に反映) ----
async function editYomi(b) {
  await setBookYomi(b.id, await promptText(t('shelf.editYomi'), t('dict.yomi'), b.yomi || '', b.title));
}

/** 文字列をひとつ入力させる小さなモーダル(キャンセルは null)。 */
function promptText(title, label, value, desc = '') {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop show';
    back.innerHTML = `<div class="modal">
      <h2>${escapeHtml(title)}</h2>
      ${desc ? `<p class="desc">${escapeHtml(desc)}</p>` : ''}
      <div class="row"><label>${escapeHtml(label)}</label>
        <input id="txt-input" class="grow" value="${escapeHtml(value || '')}"></div>
      <div class="modal-actions">
        <button id="txt-cancel">${escapeHtml(t('common.cancel'))}</button>
        <button id="txt-ok" class="primary">${escapeHtml(t('common.ok'))}</button>
      </div></div>`;
    document.body.appendChild(back);
    const input = back.querySelector('#txt-input');
    input.focus();
    input.select();
    const done = (val) => { back.remove(); resolve(val); };
    back.querySelector('#txt-cancel').addEventListener('click', () => done(null));
    back.querySelector('#txt-ok').addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); });
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
  });
}

async function setBookYomi(id, yomi) {
  if (yomi == null) return null; // キャンセル
  const b = library.find((x) => x.id === id);
  if (!b) return null;
  b.yomi = yomi.trim();
  await saveLibraryNow(library);
  render();
  return b.yomi;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- ネイティブメニューへ写す値 ----
function menuState() {
  return {
    theme: settings.theme || 'auto',
    renderMode: settings.renderMode || 'friendly',
    writingMode: settings.writingMode || 'auto',
    binding: settings.binding || 'auto',
    imageSpread: settings.imageSpread || 'auto',
    textSpread: settings.textSpread || 'auto',
    autoPagerSeconds: settings.autoPagerSeconds || 30,
    sleepTimerRunning: !!sleepTimer?.isActive,
    sleepTimerMinutes: sleepTimer?.lastMinutes ?? (settings.sleepTimerMinutes || 30),
    sleepTimerAction: sleepTimer?.action ?? (settings.sleepTimerAction || 'stopOnly'),
    profiles: profileIndex.profiles.map((p) => ({ id: p.id, name: p.name })),
    currentProfile: profileIndex.currentID,
    canExport: false,   // 書棚には書き出す対象がいない
  };
}

async function syncMenuState() {
  await refreshMenu('shelf', settings.lang, menuState());
}

/** 全書籍の既定を書き換える(書棚にいるときは本ごとの指定ではなく既定を触る)。 */
async function setDefault(key, value) {
  settings[key] = value;
  await saveSettings(settings);
  if (key === 'theme') applyTheme(value);
  await syncMenuState();
}

// ---- 起動 ----
async function main() {
  settings = await loadSettings();
  applyTheme(settings.theme);
  await loadLocale(settings.lang);
  applyTranslations();
  // 蔵書・分類・読み辞書は書棚ごとに分かれるので、どれを読むより先に現在の書棚を確かめる。
  profileIndex = await loadProfiles(t('shelf.profilePrimary'));
  await reloadShelfData();
  // リーダーで掛けたタイマーを引き継ぐ(メニューへ写す前に用意しておく)
  setupSleepTimer();
  render();
  await seedSampleIfNeeded();
  backfillMetadata();   // 待たない(書棚はすぐ触れる状態にする)

  // 「本を追加」はファイルとフォルダでパネルを分ける(1枚では混ぜて選べない)。
  // 押すとその場に小さなメニューを出す(Swift 版の Menu と同じ)。
  $('#btn-import').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = $('#btn-import').getBoundingClientRect();
    openMenu({ clientX: r.right - 210, clientY: r.bottom + 4 }, [
      { label: t('shelf.importFile'), run: pickFiles },
      { label: t('shelf.importFolder'), run: pickFolder },
    ]);
  });
  $('#ib-cancel').addEventListener('click', cancelImport);
  $('#file-fallback').addEventListener('change', (e) => {
    if (e.target.files.length) importFromFiles([...e.target.files]);
  });
  $('#btn-settings').addEventListener('click', () => openSettings(settings, async (s) => {
    settings = s; await loadLocale(s.lang); applyTranslations(); render();
    await syncMenuState(); // 言語が変わったらネイティブメニューも組み直す
  }));
  $('#btn-sidebar').addEventListener('click', () => document.body.classList.toggle('no-sidebar'));
  // メニューは画面のどこかを押したら閉じる(macOS の作法)
  document.addEventListener('click', closeMenu);
  document.addEventListener('scroll', closeMenu, true);

  // フィルタ検索 + 対象項目(すべて/タイトル/作者/出版社)
  $('#filter').addEventListener('input', (e) => { filterText = e.target.value; render(); });
  $('#filter-clear').addEventListener('click', () => { filterText = ''; $('#filter').value = ''; render(); });
  const fieldSel = $('#filter-field');
  fieldSel.value = settings.filterField || 'all';
  fieldSel.addEventListener('change', async (e) => { settings.filterField = e.target.value; await saveSettings(settings); render(); });
  // 表示モード(グリッド/作者別)。作者別のときは並び替えを隠す(五十音順で並ぶため)。
  for (const b of document.querySelectorAll('#view-seg button')) {
    b.addEventListener('click', async () => {
      settings.shelfView = b.dataset.view;
      await saveSettings(settings);
      render();
    });
  }
  // 並び替え(最近開いた/タイトル/作者/出版社)
  $('#sort-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = $('#sort-btn').getBoundingClientRect();
    openMenu({ clientX: r.right - 210, clientY: r.bottom + 4 },
      ['recent', 'title', 'author', 'publisher'].map((k) => ({
        label: (settings.sortKey || 'recent') === k ? '✓ ' + t('shelf.sort.' + k) : '　' + t('shelf.sort.' + k),
        run: async () => { settings.sortKey = k; await saveSettings(settings); render(); },
      })));
  });

  // ネイティブメニュー(本棚文脈)。処理は画面内ボタンと同じものを呼ぶだけにして二重管理を避ける。
  await setupMenu('shelf', {
    'app.settings': () => $('#btn-settings').click(),
    'file.import': pickFiles,
    'file.importFolder': pickFolder,
    'file.profiles': openProfileManager,
    'file.newProfile': newProfile,
    'file.profile.': (id) => doSwitchProfile(id),
    'tts.dict': () => openDict(() => settings),
    // スリープタイマーは本を開いていなくても操作できる(リーダーと同じ動き)
    'tts.sleep.custom': promptSleepMinutes,
    'tts.sleep.cancel': cancelSleepTimer,
    'tts.sleep.action.': (v) => { sleepTimer.setAction(v); void syncMenuState(); },
    'tts.sleep.': (v) => startSleepTimer(Number(v)),
    // 書棚にいるときは全書籍の既定を書き換える(本ごとの指定は本を開いてから)
    'view.theme.': (v) => setDefault('theme', v),
    'view.render.': (v) => setDefault('renderMode', v),
    'view.writing.': (v) => setDefault('writingMode', v),
    'view.binding.': (v) => setDefault('binding', v),
    'view.imageSpread.': (v) => setDefault('imageSpread', v),
    'view.textSpread.': (v) => setDefault('textSpread', v),
    'view.fontInc': () => changeDefaultFont(+0.1),
    'view.fontDec': () => changeDefaultFont(-0.1),
    'view.fontReset': () => setDefault('fontScale', 1.0),
    'view.lineInc': () => changeDefaultLine(+0.1),
    'view.lineDec': () => changeDefaultLine(-0.1),
    'view.lineReset': () => setDefault('lineHeight', 1.8),
  }, settings.lang, menuState());

  // ウィンドウへの EPUB / フォルダ ドラッグ&ドロップ取り込み
  enableFileDrop(async (paths) => {
    const expandedPaths = await api.expandBookPaths(paths);
    await importFromPaths(expandedPaths);
  });

  // リーダーで落とされた本。取り込んで、1 冊だけならそのまま開き直す(reader.js を参照)。
  const droppedJSON = sessionStorage.getItem('shelf-import');
  if (droppedJSON) {
    sessionStorage.removeItem('shelf-import');
    let dropped = [];
    try { dropped = JSON.parse(droppedJSON) || []; } catch { dropped = []; }
    if (dropped.length) await importDroppedFromReader(dropped);
  }

  // リーダーで「書棚を管理…」「新規書棚…」を選んだときは、本を閉じてここへ戻ってから開く
  // (シートは書棚の画面が持っているため)。
  const pending = sessionStorage.getItem('shelf-intent');
  if (pending) {
    sessionStorage.removeItem('shelf-intent');
    if (pending === 'manage') openProfileManager();
    else if (pending === 'new') newProfile();
    else if (pending.startsWith('switched:')) notice(t('shelf.profileSwitched', { name: pending.slice(9) }));
  }

  // Finder でダブルクリックされた EPUB(起動時に溜まっているぶん + 実行中に届くぶん)
  await consumePendingOpen();
  const listen = globalThis.window?.__TAURI__?.event?.listen;
  if (listen) listen('open-files', () => { void consumePendingOpen(); });

  // テストバス(computer-use 非依存の外部駆動)
  registerShelfTestbus();
  startTestbus();
}

/** ファイルを選んで取り込む。 */
async function pickFiles() {
  if (!api.IS_TAURI) { $('#file-fallback').click(); return; }
  const paths = await api.pickEpubs();
  if (paths.length) await importFromPaths(paths);
}

/** フォルダを選び、その中の EPUB をまとめて取り込む。 */
async function pickFolder() {
  await importFromPaths(await api.pickFolderEpubs());
}

async function changeDefaultFont(delta) {
  await setDefault('fontScale', Math.min(2.5, Math.max(0.6, Math.round(((settings.fontScale || 1) + delta) * 10) / 10)));
}
async function changeDefaultLine(delta) {
  await setDefault('lineHeight', Math.min(2.4, Math.max(1.0, Math.round(((settings.lineHeight || 1.8) + delta) * 10) / 10)));
}

/** Finder から渡されたファイルを取り込む。1 冊だけならそのまま開く。 */
async function consumePendingOpen() {
  let paths = [];
  try { paths = await api.takePendingOpen(); } catch { return; }
  if (!paths?.length) return;
  const expandedPaths = await api.expandBookPaths(paths);
  const before = new Set(library.map((b) => b.id));
  await importFromPaths(expandedPaths);
  const added = library.filter((b) => !before.has(b.id));
  if (added.length === 1) await openBook(added[0]);
}

// ---------------------------------------------------------------------------
// スリープタイマー(書棚からも操作できる)
// ---------------------------------------------------------------------------
//
// プロトタイプは本を開いていなくてもタイマーを触れる——「走っているタイマーを、書棚へ
// 戻ってから解除したい」という場面があるため。リーダーで掛けたタイマーは締め切りごと
// 引き継がれるので、ここで残りが分かり、ここで解除できる。

function setupSleepTimer() {
  sleepTimer = createSharedSleepTimer({
    action: settings.sleepTimerAction || 'stopOnly',
    minutes: settings.sleepTimerMinutes || 30,
    // 書棚では読み上げが走っていないので、止めるものは無い。満了したことだけ知らせる。
    onExpire: () => { notice(t('sleep.expired')); },
    power: systemPower(api),
    onActionChange: async (a) => { settings.sleepTimerAction = a; await saveSettings(settings); },
    onMinutesChange: async (m) => { settings.sleepTimerMinutes = m; await saveSettings(settings); },
  });
}

function startSleepTimer(minutes) {
  sleepTimer.start(minutes);
  notice(t('sleep.started', { t: sleepTimer.remainingText }));
  void syncMenuState();
}

function cancelSleepTimer() {
  sleepTimer.cancel();
  notice(t('sleep.canceled'));
  void syncMenuState();
}

async function promptSleepMinutes() {
  const n = await promptNumber({
    title: t('sleep.title'), label: t('sleep.minutes'),
    value: sleepTimer.lastMinutes, min: 1, max: 600, presets: PRESET_MINUTES,
  });
  if (n) startSleepTimer(n);
}

function registerShelfTestbus() {
  registerTestbus({
    state: async () => ({
      page: 'shelf', count: library.length, visible: visibleBooks().length,
      scope, profile: profileIndex.currentID,
    }),
    library: async () => library.map((b) => ({
      id: b.id, title: b.title, author: b.author, publisher: b.publisher,
      yomi: b.yomi, authorSort: b.authorSort, hasCover: !!b.cover,
      missing: !!missingIds?.has(b.id),
      favorite: col.isFavorite(b), collections: col.bookCollections(b),
      // 書棚の見出しと同じ根拠(解決済みの読み → 作者名)で分類する
      section: gojuonSection(resolvedAuthorReading(b) || b.author || '', ''),
    })),
    visible: async () => visibleBooks().map((b) => ({ id: b.id, title: b.title, author: b.author })),
    setSort: async ({ key }) => { settings.sortKey = key; await saveSettings(settings); render(); return { sortKey: key, order: visibleBooks().map((b) => b.title) }; },
    setFilter: async ({ text }) => { filterText = text || ''; $('#filter').value = filterText; render(); return { count: visibleBooks().length }; },
    setView: async ({ view }) => { settings.shelfView = view; await saveSettings(settings); render(); const heads = [...document.querySelectorAll('.section-head')].map((h) => h.textContent); return { shelfView: view, sections: heads }; },
    setYomi: async ({ id, yomi }) => { const y = await setBookYomi(id, yomi); const b = library.find((x) => x.id === id); return { id, yomi: y, section: b ? gojuonSection(resolvedAuthorReading(b) || b.author || '', '') : null }; },
    import: async ({ path, paths }) => {
      const list = paths || [path];
      await importFromPaths(await api.expandBookPaths(list));
      return library.map((b) => ({ id: b.id, title: b.title }));
    },
    importState: async () => ({
      running: !!importProgress,
      done: importProgress?.done ?? null, total: importProgress?.total ?? null,
      banner: $('#import-banner').hidden ? '' : $('#ib-title').textContent,
      stage: importStage,
      lastError: lastImportError,
    }),
    cancelImport: async () => { cancelImport(); return { cancelled: true }; },
    open: async ({ id }) => { location.href = `reader.html?id=${encodeURIComponent(id)}`; return { navigating: id }; },
    remove: async ({ id }) => { await removeBook(id); return { removed: id }; },
    resetLibrary: async () => { for (const b of library) { try { await api.deleteBook(b.id); } catch { /* noop */ } } library = []; await saveLibraryNow(library); render(); return { ok: true }; },

    // ---- お気に入り / 分類 / スコープ ----
    favorite: async ({ id, on = true }) => { await setFavorite(id, on); return { id, favorite: on }; },
    collections: async () => ({
      list: collections.map((c) => ({ id: c.id, name: c.name, parentID: c.parentID, path: col.pathName(c.id, collections) })),
      counts: col.shelfCounts(library, collections),
      rows: col.rows(collections, expanded).map((r) => ({ id: r.collection.id, depth: r.depth, hasChildren: r.hasChildren })),
    }),
    collectionAdd: async ({ name, parent = null }) => await addCollection(name, parent),
    collectionRename: async ({ id, name }) => ({ ok: await renameCollection(id, name) }),
    collectionRemove: async ({ id }) => ({ ok: await removeCollection(id) }),
    collectionMove: async ({ id, parent = null }) => ({ ok: await moveCollection(id, parent) }),
    assign: async ({ id, collection, member = true }) => ({ ok: await setMembership(id, collection, member) }),
    setScope: async ({ scope: sc }) => ({ scope: await setScope(sc), visible: visibleBooks().length }),
    shelfState: async () => ({
      scope, counts: col.shelfCounts(library, collections),
      sidebarRows: [...document.querySelectorAll('#sidebar .side-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
    }),

    // ---- 書棚(プロファイル) ----
    profiles: async () => ({
      list: profileIndex.profiles.map((p) => ({ id: p.id, name: p.name })),
      current: profileIndex.currentID,
    }),
    switchProfile: async ({ id }) => ({ current: await doSwitchProfile(id), count: library.length }),
    addProfile: async ({ name }) => {
      const { profile } = await addProfile(profileIndex, name);
      profileIndex = await loadProfiles(t('shelf.profilePrimary'));
      render();
      return profile;
    },
    renameProfile: async ({ id, name }) => {
      const r = await renameProfile(profileIndex, id, name);
      profileIndex = r.index; render();
      return { ok: r.ok };
    },
    removeProfile: async ({ id }) => {
      const r = await removeProfile(profileIndex, id);
      profileIndex = r.index; render();
      return { ok: r.ok };
    },
    menuState: async () => menuState(),

    // ---- スリープタイマー(書棚からも操作できることの確認用) ----
    sleepTimerStart: async ({ minutes = 30, seconds = null, action = null }) => {
      if (action) sleepTimer.setAction(action);
      if (seconds != null) sleepTimer.startForTest(seconds);
      else startSleepTimer(minutes);
      return sleepTimerState();
    },
    sleepTimerCancel: async () => { cancelSleepTimer(); return sleepTimerState(); },
    sleepTimerFire: async () => { sleepTimer.fireNow(); return sleepTimerState(); },
    sleepTimerShutdownCancel: async () => { sleepTimer.cancelShutdownCountdown(); return sleepTimerState(); },
    sleepTimerState: async () => sleepTimerState(),
  });
}

/** テストバス／メニューへ出すスリープタイマーの状態(リーダー側と同じ形)。 */
function sleepTimerState() {
  return {
    active: !!sleepTimer?.isActive,
    minutes: sleepTimer?.lastMinutes,
    action: sleepTimer?.action,
    remaining: sleepTimer?.remainingText,
    shutdownCountdown: sleepTimer?.shutdownCountdown ?? null,
    powerRequest: sleepTimer?.power?.lastRequest ?? null,
  };
}

main();

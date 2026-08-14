// 設定・ライブラリ・辞書の永続化(api.storeGet/Set の上の薄い型付け層)。
//
// **書棚(プロファイル)ごとに分けるもの**は `profiles.js` の SCOPED_KEYS を通す。
// 最初からある書棚は従来のキーそのままなので、書棚を増やしても既存のデータは 1 バイトも動かない。
import { storeGet, storeSet, retireProfileData } from './api.js';
import {
  PRIMARY_ID, SCOPED_KEYS, scopedKey, normalizeIndex, initialIndex,
  addProfile as addProfileTo, renameProfile as renameProfileIn,
  canRemoveProfile, removeProfile as removeProfileFrom,
} from './profiles.js';
import { normalizeCollections, parseScope } from './collections.js';

export const ENGINES = {
  voicevox: { label: 'VOICEVOX', baseUrl: 'http://127.0.0.1:50021' },
  aivis: { label: 'AivisSpeech', baseUrl: 'http://127.0.0.1:10101' },
};

export const DEFAULT_SETTINGS = {
  engine: 'voicevox', // 'voicevox' | 'aivis' | 'custom'
  customBaseUrl: 'http://127.0.0.1:50021',
  speaker: 2, // 四国めたん(ノーマル)
  speedScale: 1.0,
  pauseLengthScale: 1.5, // ユーザー確定の既定
  ttsSaveDir: '', // 読み上げ音声ファイルの保存先ディレクトリ(空=未設定, 保存時に選択させる)
  theme: 'auto', // 'auto' | 'light' | 'dark' | 'sepia'
  lang: 'auto', // 'auto' | 'ja' | 'en'
  fontScale: 1.0, // 本文の文字サイズ倍率 0.6〜2.5
  lineHeight: 1.8, // 本文の行間
  sortKey: 'recent', // 書棚の並び: 'recent' | 'title' | 'author'
  forceMargin: false, // 強制余白モード(ビュー幅を狭める)
  writingMode: 'auto', // 本文の向き: 'auto'(本の指定に従う) | 'vertical'(強制縦書き) | 'horizontal'(強制横書き)
  shelfView: 'grid', // 書棚表示: 'grid' | 'gojuon'
  userCSS: '', // 全書籍共通のカスタムCSS(書棚ごと。実体は store の 'userCSS' へ移行する)
  // ---- 表示エンジンの解釈(本ごとに上書き可。prefs.js を参照) ----
  renderMode: 'friendly', // 'friendly'(実在の EPUB を無難に表示) | 'raw'(指定どおりに描く=検版)
  binding: 'auto',        // 綴じ方向: 'auto' | 'rtl'(右綴じ) | 'ltr'(左綴じ)
  imageSpread: 'auto',    // 画像ページの見開き: 'auto' | 'always' | 'never'
  textSpread: 'auto',     // 本文の見開き: 'auto' | 'always' | 'never'
  // ---- 対訳(OpenAI 互換 API。手元のサーバーでもクラウドでもよい) ----
  translation: {},        // translate.js の DEFAULT_TRANSLATION で補完する
  // ---- 自動ページ送り / スリープタイマー(機械の設定なので書棚では分けない) ----
  autoPagerSeconds: 30,        // 直前に指定した間隔(秒)
  sleepTimerMinutes: 30,       // 直前に指定した時間(分)
  sleepTimerAction: 'stopOnly', // 'stopOnly' | 'sleepSystem' | 'shutdown'
};

// ---------------------------------------------------------------------------
// 書棚(プロファイル)
// ---------------------------------------------------------------------------

let currentProfileID = PRIMARY_ID;

/** いま見ている書棚。UI からは `switchProfile()` 以外で書き換えない。 */
export function getProfileID() {
  return currentProfileID;
}

/** 書棚ごとに分けるキーの実名。SCOPED_KEYS に無いキーはそのまま(＝全書棚で共通)。 */
export function key(name) {
  return SCOPED_KEYS.includes(name) ? scopedKey(name, currentProfileID) : name;
}

/** 書棚の一覧(`profiles`)を読む。壊れていても既定書棚 1 つの姿へ立て直す。 */
export async function loadProfiles(primaryName = 'Library') {
  const raw = await storeGet('profiles');
  const index = raw ? normalizeIndex(raw, primaryName) : initialIndex(primaryName);
  currentProfileID = index.currentID;
  return index;
}

async function saveProfiles(index) {
  currentProfileID = index.currentID;
  await storeSet('profiles', index);
  return index;
}

export async function switchProfile(index, id) {
  if (!index.profiles.some((p) => p.id === id)) return index;
  return await saveProfiles({ ...index, currentID: id });
}

export async function addProfile(index, name) {
  const { index: next, profile } = addProfileTo(index, name, null, Date.now());
  if (!profile) return { index, profile: null };
  await saveProfiles(next);
  return { index: next, profile };
}

export async function renameProfile(index, id, name) {
  const { index: next, ok } = renameProfileIn(index, id, name);
  if (ok) await saveProfiles(next);
  return { index: next, ok };
}

export { canRemoveProfile };

/** 書棚を消す。データは消さず `Deleted/` へ寄せる(取り違えて消したときに戻せるように)。 */
export async function removeProfile(index, id) {
  const { index: next, ok } = removeProfileFrom(index, id);
  if (!ok) return { index, ok: false };
  await saveProfiles(next);
  await retireProfileData(id).catch(() => 0);
  return { index: next, ok: true };
}

// ---------------------------------------------------------------------------
// 各種データ
// ---------------------------------------------------------------------------

// 対訳の訳文キャッシュ(段落単位)。上限・デバウンスは translate.js が持つ。
export async function loadTranslationCache() {
  return (await storeGet('translation-cache')) || {};
}
export async function saveTranslationCache(obj) {
  await storeSet('translation-cache', obj);
}

export function engineBaseUrl(settings) {
  if (settings.engine === 'custom') return settings.customBaseUrl;
  return ENGINES[settings.engine]?.baseUrl ?? DEFAULT_SETTINGS.customBaseUrl;
}

export async function loadSettings() {
  const s = (await storeGet('settings')) || {};
  return { ...DEFAULT_SETTINGS, ...s };
}
export async function saveSettings(s) {
  await storeSet('settings', s);
}

// ライブラリ: [{ id, title, author, yomi, cover(dataURL|null), addedAt, progress,
//               favorite, collections: [collectionID] }]
export async function loadLibrary() {
  return (await storeGet(key('library'))) || [];
}

/**
 * 蔵書を保存する。
 *
 * **なぜまとめ書きにするか。** 蔵書は 1 ファイルに全冊まとめて書くので、1 冊ぶんの変更でも
 * 全冊のエンコードとファイル書き出しが走る。それがページを送るたび(位置の保存)・1 冊登録する
 * たびに起きると、冊数が増えるほど読書も登録も詰まる。保存の要求は最新の姿を控えるだけにして、
 * 少し待ってから 1 回だけ書く。
 *
 * 落とさないための約束: 溜めたぶんはページを離れるとき(`pagehide`)に `flushLibrary()` で
 * 必ず書き切る。
 */
const COALESCE_MS = 700;
let pendingLibrary = null;
let flushTimer = null;

export async function saveLibrary(list) {
  pendingLibrary = list;
  if (flushTimer != null) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushLibrary(); }, COALESCE_MS);
}

/** 溜めたぶんを書き切る。 */
export async function flushLibrary() {
  if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
  if (pendingLibrary == null) return;
  const snapshot = pendingLibrary;
  pendingLibrary = null;
  await storeSet(key('library'), snapshot);
}

/** すぐ書く(削除・取り込みの完了時など、落ちたら困る変更)。 */
export async function saveLibraryNow(list) {
  pendingLibrary = list;
  await flushLibrary();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flushLibrary(); });
}

// 辞書: [{ surface, reading, layer, kind, padsBoundary, enabled }]
export async function loadDict() {
  return (await storeGet(key('dict'))) || [];
}
export async function saveDict(list) {
  await storeSet(key('dict'), list);
}

// 分類(コレクション): [{ id, name, parentID, order }]
export async function loadCollections() {
  return normalizeCollections((await storeGet(key('collections'))) || []);
}
export async function saveCollections(list) {
  await storeSet(key('collections'), normalizeCollections(list));
}

// サイドバーで選んでいるスコープ('all' | 'favorites' | 'unfiled' | 'collection:<id>')
export async function loadShelfScope() {
  return parseScope(await storeGet(key('shelfScope')));
}
export async function saveShelfScope(scope) {
  await storeSet(key('shelfScope'), parseScope(scope));
}

/**
 * 全書籍共通のカスタムCSS。書棚ごとに分ける(手元の蔵書に合わせた調整を別の書棚に出さない)。
 * 旧版は `settings.userCSS` に入れていたので、まだ移していなければそこから引き継ぐ。
 */
export async function loadUserCSS(settings = null) {
  const v = await storeGet(key('userCSS'));
  if (typeof v === 'string') return v;
  const legacy = settings?.userCSS;
  return typeof legacy === 'string' ? legacy : '';
}
export async function saveUserCSS(css) {
  await storeSet(key('userCSS'), String(css || ''));
}

// 最後に読んだ本({id, at})。書棚の地に敷く表紙もこれで決まるので書棚ごとに分ける。
export async function loadLastRead() {
  return (await storeGet(key('last-read'))) || null;
}
export async function saveLastRead(v) {
  await storeSet(key('last-read'), v);
}

// Tauri コマンドの薄いラッパー。
// Tauri 内では window.__TAURI__.core.invoke を使う。
// ブラウザ(検証用)では未定義なので、モック/no-op にフォールバックし、UI 開発を単体で回せるようにする。

const hasTauri = typeof window !== 'undefined' && window.__TAURI__?.core?.invoke;
export const IS_TAURI = !!hasTauri;

function rawInvoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// --- 汎用ストア ---
export async function storeGet(name) {
  if (IS_TAURI) return rawInvoke('store_get', { name });
  try { return JSON.parse(localStorage.getItem('store:' + name)); } catch { return null; }
}
export async function storeSet(name, value) {
  if (IS_TAURI) return rawInvoke('store_set', { name, value });
  localStorage.setItem('store:' + name, JSON.stringify(value));
}
/** キーを 1 つ消す。無いキーを指定しても失敗にはならない。 */
export async function storeDelete(name) {
  if (IS_TAURI) return rawInvoke('store_delete', { name });
  localStorage.removeItem('store:' + name);
}

// --- ライブラリ ---
export async function pickEpubs() {
  if (IS_TAURI) return rawInvoke('pick_epubs');
  return []; // ブラウザではファイルダイアログを別途 <input> で扱う
}
/** フォルダを1つ選ばせ、その中の EPUB を再帰的に集めて返す(自然順・上限5000)。 */
export async function pickFolderEpubs() {
  if (IS_TAURI) return rawInvoke('pick_folder_epubs');
  return [];
}
/** パスの並びを取り込めるファイルの並びへ展開する(フォルダはその中身に置き換える)。 */
export async function expandBookPaths(paths) {
  if (IS_TAURI) return rawInvoke('expand_book_paths', { paths });
  return paths.filter((p) => /\.(epub|cbz|fb2|fbz|mobi|azw3?|kf8)$/i.test(p));
}
/** Finder からのダブルクリックで溜まっているファイルを取り出す(取り出したぶんは消える)。 */
export async function takePendingOpen() {
  if (IS_TAURI) return rawInvoke('take_pending_open');
  return [];
}
export async function readFileB64(path) {
  if (IS_TAURI) return rawInvoke('read_file_b64', { path });
  throw new Error('read_file_b64 unavailable outside Tauri');
}

// --- 電源操作(スリープタイマーの満了動作) ---
// ブラウザ検証では実行できないので、要求したことだけを返す。
export async function systemSleep() {
  if (IS_TAURI) return rawInvoke('system_sleep');
  console.warn('[sleepTimer] system sleep requested (no-op outside Tauri)');
}
export async function systemShutdown() {
  if (IS_TAURI) return rawInvoke('system_shutdown');
  console.warn('[sleepTimer] system shutdown requested (no-op outside Tauri)');
}

/** 消した書棚のデータを Deleted/ へ寄せる(消さない)。移した件数を返す。 */
export async function retireProfileData(id) {
  if (IS_TAURI) return rawInvoke('retire_profile_data', { id });
  return 0;
}
export async function importBook(srcPath, id) {
  if (IS_TAURI) return rawInvoke('import_book', { srcPath, id });
  return '';
}
/** バイト列そのものを取り込む(元パスを持てない同梱サンプル用)。 */
export async function importBookBytes(id, dataB64, ext = 'epub') {
  if (IS_TAURI) return rawInvoke('import_book_bytes', { id, dataB64, ext });
  return '';
}
/**
 * 取り込み済みの本を読む。`{ ext, data }` を返す。
 * **拡張子が要る**——CBZ と FBZ は ZIP なので、foliate は名前を見ないと EPUB と区別できない。
 */
export async function readBook(id) {
  if (IS_TAURI) return rawInvoke('read_book_b64', { id });
  // ブラウザ検証: test-books/ から読む(id をファイル名として扱う)。
  // 拡張子は決め打ちにできない——CBZ と FBZ は ZIP なので、foliate は名前を見ないと
  // EPUB と区別できない。当たるまで順に引く(検証用なので回数は気にしない)。
  for (const ext of ['epub', 'cbz', 'fb2', 'fbz', 'mobi', 'azw3']) {
    const res = await fetch(new URL(`../../test-books/${id}.${ext}`, import.meta.url));
    if (res.ok) return { ext, data: b64FromArrayBuffer(await res.arrayBuffer()) };
  }
  throw new Error(`test book not found: ${id}`);
}
export async function deleteBook(id) {
  if (IS_TAURI) return rawInvoke('delete_book', { id });
}
/** 取り込み済みの本の id 一覧(実在判定用)。ブラウザ検証では null = 判定しない。 */
export async function listBooks() {
  if (IS_TAURI) return rawInvoke('list_books');
  return null;
}
// --- 読み上げ音声のファイル保存 ---
// フォルダ選択ダイアログ。選ばれたパス(なければ null)を返す。
export async function pickDirectory() {
  if (IS_TAURI) return rawInvoke('pick_directory');
  return null; // ブラウザ検証: ダイアログ非対応
}
// OS の保存パネルを出し、ユーザーが決めたフルパスを返す(キャンセルは null)。
// tauri-plugin-dialog を使うので macOS でも Windows でも動く。
export async function saveFileDialog(defaultName, ext = '') {
  if (IS_TAURI) return rawInvoke('save_file_dialog', { defaultName, ext });
  return defaultName; // ブラウザ検証: ダウンロードにフォールバックさせるため名前だけ返す
}
// base64 バイト列を指定フルパスへ保存。保存先パスを返す。
export async function writeBytes(path, dataB64) {
  if (IS_TAURI) return rawInvoke('write_bytes', { path, dataB64 });
  const url = URL.createObjectURL(blobFromB64(dataB64));
  const a = document.createElement('a');
  a.href = url; a.download = String(path).split('/').pop() || 'download';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return path;
}

// base64 バイト列を dir/filename に保存。保存先の絶対パスを返す。
// ブラウザ検証では Tauri が無いのでダウンロードにフォールバックする。
export async function saveBytes(dir, filename, dataB64, type = 'application/octet-stream') {
  if (IS_TAURI) return rawInvoke('save_bytes', { dir, filename, dataB64 });
  const url = URL.createObjectURL(blobFromB64(dataB64, type));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

// --- ネイティブメニュー ---
// 言語(設定値 'auto'|'ja'|'en')と文脈('shelf'|'reader')でメニューを作り直させる。
// ブラウザ検証時はネイティブメニューが無いので no-op。
export async function syncMenu(lang, ctx, state = null) {
  if (IS_TAURI) return rawInvoke('sync_menu', { lang, ctx, state });
}

// 自ウィンドウのスクリーンショット(PNG base64)。テスト検証用。
export async function captureWindow() {
  if (IS_TAURI) return rawInvoke('capture_window');
  throw new Error('capture_window unavailable outside Tauri');
}

// xcap から見えているウィンドウの一覧。captureWindow が「見つかりません」と言うとき、
// 何が見えているのかを確かめるために使う。検証専用。
export async function listWindows() {
  if (IS_TAURI) return rawInvoke('list_windows');
  throw new Error('list_windows unavailable outside Tauri');
}

/**
 * テストバスを起動してよいか(バックエンドに聞く)。
 * 配布ビルドでは既定 false ——`EPUB_READER_TESTBUS=1` を付けて起動したときだけ true。
 * 理由は `src-tauri/src/lib.rs` の `testbus_allowed` を参照。
 */
/**
 * テストバスを使ってよいか(デバッグビルド、または EPUB_READER_TESTBUS=1)。
 *
 * **バックエンドへ問い合わせられなかったときは例外をそのまま投げる。** 呼び出し側が
 * 「無効だった(false)」と「まだ問い合わせられない(例外)」を区別できるようにするため。
 * ここで握り潰して false を返すと、ページを読み込み直した直後のように IPC がまだ
 * 整っていない一瞬に当たっただけで、そのページではテストバスが二度と起動しなくなる。
 */
export async function testbusEnabled() {
  if (!IS_TAURI) return false;
  return !!(await rawInvoke('testbus_enabled'));
}

// --- VOICEVOX / AivisSpeech ---
export async function voicevoxVersion(baseUrl) {
  if (IS_TAURI) return rawInvoke('voicevox_version', { baseUrl });
  const r = await fetch(baseUrl.replace(/\/$/, '') + '/version'); return r.text();
}
/**
 * 読み上げエンジンのアプリを起動する。engine は 'voicevox' か 'aivis'。
 * macOS は `open -a`、Windows は `%LOCALAPPDATA%\Programs\<名前>\<名前>.exe` などを順に探す。
 * 既に動いていれば何も起きない。**入っていなければ「見つからない」と返る。**
 * ブラウザ検証では何もしない。
 */
export async function launchTtsEngine(engine) {
  if (!IS_TAURI) throw new Error('not tauri');
  return rawInvoke('launch_tts_engine', { engine });
}
export async function voicevoxSpeakers(baseUrl) {
  if (IS_TAURI) return rawInvoke('voicevox_speakers', { baseUrl });
  const r = await fetch(baseUrl.replace(/\/$/, '') + '/speakers'); return r.json();
}
/**
 * テキストを合成して WAV(base64) を返す。
 * gapCount / silenceGaps は読み辞書が挿入した語境界を無音化するための情報
 * (dictionary.prepare() の戻り値をそのまま渡す。SPECIFICATION.ja.md §10.2)。
 */
export async function voicevoxSynthesize(baseUrl, text, speaker, speedScale, pauseLengthScale, gaps = null) {
  const gapCount = gaps?.gapCount ?? null;
  const silenceGaps = gaps?.silenceGaps?.length ? gaps.silenceGaps : null;
  if (IS_TAURI) return rawInvoke('voicevox_synthesize', { baseUrl, text, speaker, speedScale, pauseLengthScale, gapCount, silenceGaps });
  // ブラウザ検証: 直接叩く(CORS が許可されていれば)
  const base = baseUrl.replace(/\/$/, '');
  const q = await (await fetch(`${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: 'POST' })).json();
  q.speedScale = speedScale;
  if ('pauseLengthScale' in q) q.pauseLengthScale = pauseLengthScale;
  if (silenceGaps) silenceInsertedGaps(q, gapCount, silenceGaps);
  const wav = await (await fetch(`${base}/synthesis?speaker=${speaker}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q) })).arrayBuffer();
  return b64FromArrayBuffer(wav);
}

// ブラウザ検証用。Tauri では同じ処理を Rust 側(silence_inserted_gaps)が行う。
function silenceInsertedGaps(query, gapCount, silenceGaps) {
  const phrases = query?.accent_phrases;
  if (!Array.isArray(phrases)) return;
  const withPause = phrases.filter((p) => p?.pause_mora);
  if (gapCount != null && gapCount >= 0 && withPause.length !== gapCount) return; // 数え方が食い違ったら触らない
  withPause.forEach((p, i) => { if (silenceGaps.includes(i)) p.pause_mora.vowel_length = 0; });
}

// --- 対訳(OpenAI 互換 API。LM Studio 等のローカルでもクラウドでも同じ経路) ---
// apiKey が空でなければ Authorization: Bearer を付ける(ローカルは空でよい)。
export async function lmModels(baseUrl, apiKey = '') {
  if (IS_TAURI) return rawInvoke('lm_models', { baseUrl, apiKey });
  const b = baseUrl.replace(/\/$/, '');
  const url = b.endsWith('/v1') ? `${b}/models` : `${b}/v1/models`;
  const r = await fetch(url, { headers: authHeaders(apiKey) });
  const v = await r.json();
  return (v.data || []).map((m) => m.id).filter((id) => !String(id).toLowerCase().includes('embed'));
}
export async function lmChat(baseUrl, model, system, user, temperature, disableThinking, opts = {}) {
  const { apiKey = '', prefillThink = false } = opts;
  if (IS_TAURI) return rawInvoke('lm_chat', { baseUrl, model, system, user, temperature, disableThinking, apiKey, prefillThink });
  const b = baseUrl.replace(/\/$/, '');
  const url = b.endsWith('/v1') ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  // 思考済みとして発話を継続させる。詳細は translate.js の prefillThinkClose を参照。
  if (prefillThink) messages.push({ role: 'assistant', content: '<think>\n\n</think>\n\n' });
  const body = {
    model, temperature, stream: false,
    max_tokens: Math.min(4096, Math.max(512, user.length)),
    messages,
  };
  if (disableThinking) body.chat_template_kwargs = { enable_thinking: false };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify(body),
  });
  const v = await r.json();
  return v?.choices?.[0]?.message?.content ?? '';
}
function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
export async function voicevoxRegisterWord(baseUrl, surface, pronunciation, accentType, priority) {
  if (IS_TAURI) return rawInvoke('voicevox_register_word', { baseUrl, surface, pronunciation, accentType, priority });
  return '';
}

// --- utils ---
export function b64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
export function blobFromB64(b64, type = 'application/octet-stream') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
function u8FromB64(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function b64FromU8(u8) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(bin);
}
// WAV(RIFF) の指定チャンクの {start,size} を返す(fflate 等は使わず素朴に走査)。
function findWavChunk(bytes, id) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12; // 'RIFF'(4) + size(4) + 'WAVE'(4)
  while (pos + 8 <= bytes.length) {
    const cid = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = dv.getUint32(pos + 4, true);
    if (cid === id) return { start: pos + 8, size };
    pos += 8 + size + (size & 1); // チャンクは偶数境界にパディング
  }
  return null;
}
/**
 * 同一フォーマットの WAV(base64)配列を1つの WAV(base64)へ連結する。
 * 先頭の fmt チャンクを流用し、全 data チャンクを結合してヘッダを書き直す。
 * VOICEVOX/AivisSpeech は文ごとに同じサンプルレート/チャンネル数を返すため連結可能。
 */
// WAV(base64)の再生秒数を厳密に返す(fmt/data チャンクから算出)。
export function wavDurationSec(b64) {
  const u = u8FromB64(b64);
  const fmt = findWavChunk(u, 'fmt ');
  const data = findWavChunk(u, 'data');
  if (!fmt || !data) return 0;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const channels = dv.getUint16(fmt.start + 2, true);
  const rate = dv.getUint32(fmt.start + 4, true);
  const bits = dv.getUint16(fmt.start + 14, true);
  const bytesPerSample = (bits / 8) * channels;
  return bytesPerSample ? data.size / (rate * bytesPerSample) : 0;
}
export function mergeWavB64(list) {
  if (!list || !list.length) throw new Error('mergeWavB64: empty');
  if (list.length === 1) return list[0];
  const bufs = list.map(u8FromB64);
  const fmt = findWavChunk(bufs[0], 'fmt ');
  if (!fmt) throw new Error('mergeWavB64: fmt chunk not found');
  const datas = bufs.map((b) => {
    const d = findWavChunk(b, 'data');
    if (!d) throw new Error('mergeWavB64: data chunk not found');
    return b.subarray(d.start, d.start + d.size);
  });
  const totalData = datas.reduce((n, d) => n + d.length, 0);
  const out = new Uint8Array(12 + 8 + fmt.size + 8 + totalData);
  const dv = new DataView(out.buffer);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  wr(0, 'RIFF');
  dv.setUint32(4, 4 + (8 + fmt.size) + (8 + totalData), true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  dv.setUint32(16, fmt.size, true);
  out.set(bufs[0].subarray(fmt.start, fmt.start + fmt.size), 20);
  let pos = 20 + fmt.size;
  wr(pos, 'data');
  dv.setUint32(pos + 4, totalData, true);
  pos += 8;
  for (const d of datas) { out.set(d, pos); pos += d.length; }
  return b64FromU8(out);
}

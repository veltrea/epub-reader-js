// 書棚(プロファイル)の一覧と「いまどれを見ているか」。DOM にも永続化にも依らない純ロジック。
//
// **なぜ要るか。** 手元の蔵書には人へ見せられない本が混じる(仕事で預かったデータなど)。
// 画面を見せるとき欲しいのは「隠す」ことではなく「そのファイルを読んでいない」状態である。
// 隠す作りは、解除し忘れ・表紙のキャッシュの残り・書棚の地に敷いた表紙のような経路を
// **一つ見落とせばそのまま漏れる**。読む先を切り替える作りなら、見落としが原理的に起こらない。
//
// 本の実体(books/<id>.epub)は分けない。書棚を消してもファイルは消えない。

/** 最初からある書棚。**既存のデータはここに入る。** */
export const PRIMARY_ID = '00000000-0000-0000-0000-00000000e9b0';

/** 名前の無い書棚に入れる名前。保存される値なので訳さない(言語を変えると名前が入れ替わるため)。 */
export const UNTITLED_NAME = 'Shelf';

export function isPrimary(id) {
  return id === PRIMARY_ID;
}

/**
 * 壊れた・欠けたデータを立て直した姿を返す。
 * - 最初からある書棚が無ければ先頭に足す(読み込みに失敗しても既存の蔵書へ戻れる)
 * - ID の重複は後から来たほうを捨てる
 * - 名前が空の書棚はメニューで選べなくなるので、既定の名前を入れる
 * - いま見ている書棚がもう無ければ、最初からある書棚に戻す
 */
export function normalizeIndex(index, primaryName = 'Library') {
  const src = Array.isArray(index?.profiles) ? index.profiles : [];
  const seen = new Set();
  const list = [];
  for (const p of src) {
    const id = String(p?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(p?.name ?? '').trim();
    list.push({
      id,
      name: name || (isPrimary(id) ? primaryName : UNTITLED_NAME),
      createdAt: Number.isFinite(p?.createdAt) ? p.createdAt : 0,
    });
  }
  if (!list.some((p) => isPrimary(p.id))) {
    list.unshift({ id: PRIMARY_ID, name: primaryName, createdAt: 0 });
  }
  const currentID = list.some((p) => p.id === index?.currentID) ? index.currentID : PRIMARY_ID;
  return { profiles: list, currentID };
}

export function initialIndex(primaryName = 'Library') {
  return { profiles: [{ id: PRIMARY_ID, name: primaryName, createdAt: 0 }], currentID: PRIMARY_ID };
}

/** 書棚を足す。名前が空なら作らない。{index, profile} を返す。 */
export function addProfile(index, name, id = null, now = 0) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return { index, profile: null };
  const profile = { id: id || cryptoRandomID(), name: trimmed, createdAt: now };
  return { index: { ...index, profiles: [...index.profiles, profile] }, profile };
}

export function renameProfile(index, id, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || !index.profiles.some((p) => p.id === id)) return { index, ok: false };
  return {
    index: { ...index, profiles: index.profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p)) },
    ok: true,
  };
}

/**
 * 書棚を消せるか。
 * **最初からある書棚と、いま見ている書棚は消せない。** 前者は既存の蔵書の置き場所そのもので、
 * 後者は消した瞬間に行き先が無くなる(先に切り替えてもらう)。
 */
export function canRemoveProfile(index, id) {
  return !isPrimary(id) && id !== index.currentID && index.profiles.some((p) => p.id === id);
}

export function removeProfile(index, id) {
  if (!canRemoveProfile(index, id)) return { index, ok: false };
  return { index: { ...index, profiles: index.profiles.filter((p) => p.id !== id) }, ok: true };
}

/**
 * 書棚ごとに分けるキーの実名。
 * **最初からある書棚は従来のキーそのまま**で、増やした書棚だけ `キー#<uuid>` にする。
 * 既存の設定を移し替えないので、書棚を増やしても手元の蔵書・読み辞書・共通CSS はそのまま残る。
 */
export function scopedKey(name, profileID) {
  return isPrimary(profileID) ? name : `${name}#${profileID}`;
}

/**
 * 書棚ごとに分ける対象。**増やしたらここへ足すこと**——書棚を消したときに落とすキーの一覧も
 * ここから引くので、片方だけ足すと消し残る。
 *
 * 分けるのは「蔵書に紐づくもの」だけ。読み上げエンジンの接続先やテーマのような
 * 「機械の設定」(`settings`)は分けない(書棚を切り替えるたびに繋ぎ直すことになるため)。
 */
export const SCOPED_KEYS = [
  'library',        // 蔵書
  'collections',    // 分類
  'dict',           // 読み辞書(登録語はそのまま作品の固有名詞になる)
  'userCSS',        // 全書籍共通CSS(手元の蔵書に合わせた調整を別の書棚に出さない)
  'last-read',      // 最後に読んだ本(書棚の地に敷く表紙もこれで決まる)
  'shelfScope',     // 選択中のスコープ(別の書棚に無い分類を指してしまうため)
];

function cryptoRandomID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

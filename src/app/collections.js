// 分類(コレクション)とスコープ。DOM にも永続化にも依らない純ロジック。
//
// 分類は `parentID` で入れ子にできる(「小説 > SF」のような形)。所属は**本の側**が持つ
// (`book.collections = [id, ...]`)。分類の側に本の一覧を持たせないのは、本を消したときに
// 分類側の掃除が要らないこと、そして 1 冊が複数の分類に入れる(作者別と叢書別の両方に置く)
// ようにするため。
//
// 読み込んだ JSON は信用しない。親子が輪になっていても、たどる側は必ず訪問済みを控えて止まる。

/** 分類 1 件を既定値で埋める。壊れた値(名前が空・order が数でない)はここで均す。 */
export function normalizeCollection(c, i = 0) {
  return {
    id: String(c?.id || ''),
    name: String(c?.name ?? '').trim(),
    parentID: c?.parentID ? String(c.parentID) : null,
    order: Number.isFinite(c?.order) ? c.order : i,
  };
}

/**
 * 分類の一覧を立て直す。
 * - id の無いもの・重複は落とす(保存先が同じものを二つ並べない)
 * - 名前が空のものは選べなくなるので落とす
 * - 親が存在しない分類は最上位へ繰り上げる(孤児を隠さない)
 * - 自分自身を親にしているものは最上位へ
 */
export function normalizeCollections(list) {
  const src = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = normalizeCollection(src[i], i);
    if (!c.id || !c.name || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  for (const c of out) {
    if (c.parentID === c.id || (c.parentID && !seen.has(c.parentID))) c.parentID = null;
  }
  return out;
}

/** 親 → 子の対応表。何度もたどるときはこれを 1 回作って使い回す。 */
export function childMap(all) {
  const map = new Map();
  for (const c of all) {
    const key = c.parentID || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'ja', { numeric: true }));
  }
  return map;
}

export function children(parentID, all) {
  return childMap(all).get(parentID || '') || [];
}

/** `id` とその子孫すべての ID。分類を選んだときに「下の階層の本も出す」ために使う。 */
export function selfAndDescendants(id, all) {
  const map = childMap(all);
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;   // 輪になっていても止まる
    out.add(cur);
    for (const child of map.get(cur) || []) stack.push(child.id);
  }
  return out;
}

/** `candidate` が `ancestor` の子孫か(自分自身も真)。親の付け替えで循環を作らせないために使う。 */
export function isDescendant(candidate, ancestor, all) {
  return selfAndDescendants(ancestor, all).has(candidate);
}

/** サイドバーに縦に並べるための平らな列。`expanded` に無い分類の下は畳んで出さない。 */
export function rows(all, expanded = new Set()) {
  const map = childMap(all);
  const out = [];
  const visited = new Set();
  const walk = (parent, depth) => {
    for (const c of map.get(parent || '') || []) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      const kids = map.get(c.id) || [];
      out.push({ collection: c, depth, hasChildren: kids.length > 0 });
      if (expanded.has(c.id)) walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 「小説 / SF / 海外」のような、上からの道筋。 */
export function pathName(id, all) {
  const byID = new Map(all.map((c) => [c.id, c]));
  const names = [];
  let cur = id;
  let guard = 0;
  while (cur && byID.has(cur) && guard <= all.length) {
    const c = byID.get(cur);
    names.push(c.name);
    cur = c.parentID;
    guard++;
  }
  return names.reverse().join(' / ');
}

/** 分類を消すときに、子を親へ繰り上げた姿を返す(階層に穴を空けない)。 */
export function removing(id, all) {
  const target = all.find((c) => c.id === id);
  if (!target) return all;
  return all
    .filter((c) => c.id !== id)
    .map((c) => (c.parentID === id ? { ...c, parentID: target.parentID } : c));
}

/** 同じ親の中で次に使う並び順。 */
export function nextOrder(parentID, all) {
  const p = parentID || null;
  return all.filter((c) => (c.parentID || null) === p).reduce((m, c) => Math.max(m, c.order), -1) + 1;
}

// ---- スコープ(サイドバーの選択そのもの) ----

export const SCOPE_ALL = 'all';
export const SCOPE_FAVORITES = 'favorites';
export const SCOPE_UNFILED = 'unfiled';

/** 保存・テストバス用の文字列表現から実体へ。未知の値はすべて「すべて」に倒す。 */
export function parseScope(raw) {
  const s = String(raw || '');
  if (s === SCOPE_FAVORITES || s === SCOPE_UNFILED) return s;
  if (s.startsWith('collection:') && s.slice('collection:'.length)) return s;
  return SCOPE_ALL;
}

export function collectionOfScope(scope) {
  const s = String(scope || '');
  return s.startsWith('collection:') ? s.slice('collection:'.length) : null;
}

/** 本が分類に入っているか(スコープの判定に使う。壊れた値は空配列扱い)。 */
export function bookCollections(b) {
  return Array.isArray(b?.collections) ? b.collections.filter(Boolean) : [];
}

export function isFavorite(b) {
  return b?.favorite === true;
}

/** スコープに入る本だけを返す。分類は子孫の分類に入っている本も含む。 */
export function booksInScope(books, scope, all) {
  const list = Array.isArray(books) ? books : [];
  if (scope === SCOPE_FAVORITES) return list.filter(isFavorite);
  if (scope === SCOPE_UNFILED) return list.filter((b) => bookCollections(b).length === 0);
  const cid = collectionOfScope(scope);
  if (!cid) return list;
  const family = selfAndDescendants(cid, all);
  return list.filter((b) => bookCollections(b).some((x) => family.has(x)));
}

/** サイドバーの冊数バッジ。分類は子孫ぶんも数える。 */
export function shelfCounts(books, all) {
  const list = Array.isArray(books) ? books : [];
  const counts = {
    [SCOPE_ALL]: list.length,
    [SCOPE_FAVORITES]: list.filter(isFavorite).length,
    [SCOPE_UNFILED]: list.filter((b) => bookCollections(b).length === 0).length,
  };
  for (const c of all) {
    const family = selfAndDescendants(c.id, all);
    counts['collection:' + c.id] = list.filter((b) => bookCollections(b).some((x) => family.has(x))).length;
  }
  return counts;
}

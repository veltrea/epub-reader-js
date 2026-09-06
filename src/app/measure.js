// 測定オーバーレイ（計りレイヤー）。組版を直すときに使う道具で、読者には見せない。
// 移植元(Swift 版プロトタイプ)の仕様書 §14.1–14.4 に対応する。
//
// 画面の上に「色の物差し」を重ねる。上辺に X 座標、左辺に Y 座標のリボンを敷き、
// 端の 2 セルの色を読むだけで絶対座標が分かる。写真を見るだけで座標が読めるので、
// 定規を当てなくてよい。目で読んだ色と、コードが返す数の両方で裏が取れる。
//
// このファイルは DOM も foliate も参照しない。canvas の 2D コンテキストと
// document / window は引数で受け取る。窓の層と本文の層の両方がこれを使う。

/** 1 セルの大きさ(px)。端からセルを数える／色を読むと座標が分かる。 */
export const CELL = 10;

/**
 * 16 色パレット。互いに見分けやすい配色で、番号が座標の「桁」を表す。
 * ★この並びを変えてはいけない。元アプリと同じ色・同じ符号化にしておくと、
 *   元アプリで撮った写真と新版で撮った写真を、同じ物差しで比べられる。
 */
export const PALETTE = [
  '#E6194B', '#F58231', '#FFE119', '#BFEF45',
  '#3CB44B', '#469990', '#42D4F4', '#4363D8',
  '#000075', '#911EB4', '#F032E6', '#FABED4',
  '#9A6324', '#FFFAC8', '#AAFFC3', '#A9A9A9',
];

/** 小数第 1 位に丸める。 */
export const r1 = (v) => Math.round(v * 10) / 10;

/**
 * 座標(px)を色帯の読みに変える。
 * cell = 何セル目か、low = 1 の位(下のレーンの色番号)、high = 16 の位(上のレーンの色番号)。
 * 写真から読んだ色が `high * 16 + low` になっていれば、物差しはずれていない。
 */
export function band(v) {
  const c = Math.round(v / CELL);
  return { cell: c, low: ((c % 16) + 16) % 16, high: ((Math.floor(c / 16) % 16) + 16) % 16 };
}

/** そのセル番号の 2 レーンの色。下が 1 の位、上が 16 の位。 */
export function laneColors(cellIndex) {
  const b = band(cellIndex * CELL);
  return { low: PALETTE[b.low], high: PALETTE[b.high] };
}

/**
 * 物差しを描く。ctx は canvas の 2D コンテキスト、W/H は px の大きさ。
 * 描く順番は元アプリと同じ: リボン → 16 セルごとの境界線 → 10% グリッド →
 * 外周枠と目盛り → 中央十字と寸法 → 凡例 → 原点マーカー。
 */
export function drawMeasureGrid(ctx, W, H) {
  if (!(W > 1) || !(H > 1)) return false;
  ctx.clearRect(0, 0, W, H);

  // 上辺(X)・左辺(Y)の 16 色 2 レーンのリボン
  ctx.globalAlpha = 0.9;
  for (let i = 0, x = 0; x < W; i++, x += CELL) {
    ctx.fillStyle = PALETTE[i % 16];
    ctx.fillRect(x, 0, CELL, CELL);
    ctx.fillStyle = PALETTE[Math.floor(i / 16) % 16];
    ctx.fillRect(x, CELL, CELL, CELL);
  }
  for (let j = 0, y = 0; y < H; j++, y += CELL) {
    ctx.fillStyle = PALETTE[j % 16];
    ctx.fillRect(0, y, CELL, CELL);
    ctx.fillStyle = PALETTE[Math.floor(j / 16) % 16];
    ctx.fillRect(CELL, y, CELL, CELL);
  }
  ctx.globalAlpha = 1;

  const bandW = CELL * 2; // リボンの厚み(下位 + 上位の 2 レーン)

  // 16 セル(=160px)ごとの境界線。周回の切れ目を分かりやすくする
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0, x = 0; x < W; k++, x += CELL) {
    if (k % 16 === 0) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, bandW); }
  }
  for (let m = 0, y = 0; y < H; m++, y += CELL) {
    if (m % 16 === 0) { ctx.moveTo(0, y + 0.5); ctx.lineTo(bandW, y + 0.5); }
  }
  ctx.stroke();

  // 10% 刻みのグリッド線
  ctx.strokeStyle = 'rgba(128,128,128,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 1; g < 10; g++) {
    const gx = Math.round(W * g / 10) + 0.5;
    const gy = Math.round(H * g / 10) + 0.5;
    ctx.moveTo(gx, 0); ctx.lineTo(gx, H);
    ctx.moveTo(0, gy); ctx.lineTo(W, gy);
  }
  ctx.stroke();

  // 外周枠 + 四辺の 10% 目盛り
  ctx.strokeStyle = 'rgba(255,45,85,0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  ctx.beginPath();
  const tick = 12;
  for (let p = 0; p <= 100; p += 10) {
    const px = Math.round((W - 1) * p / 100);
    const py = Math.round((H - 1) * p / 100);
    ctx.moveTo(px, bandW); ctx.lineTo(px, bandW + tick);
    ctx.moveTo(px, H); ctx.lineTo(px, H - tick);
    ctx.moveTo(bandW, py); ctx.lineTo(bandW + tick, py);
    ctx.moveTo(W, py); ctx.lineTo(W - tick, py);
  }
  ctx.stroke();

  // 中央十字 + ビューポートの寸法
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  ctx.strokeStyle = 'rgba(52,199,89,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 24); ctx.lineTo(cx, cy + 24);
  ctx.moveTo(cx - 24, cy); ctx.lineTo(cx + 24, cy);
  ctx.stroke();
  ctx.fillStyle = 'rgba(52,199,89,0.95)';
  ctx.font = 'bold 11px -apple-system,monospace';
  ctx.fillText(`viewport ${Math.round(W)}x${Math.round(H)} px / cell=${CELL}px`, cx + 6, cy + 18);

  // 凡例(0–F の 16 スウォッチ)。写真の色から桁を読み戻すために要る
  const lx = cx - 130, ly = cy + 26, sw = 15, hh = 13;
  const hex = '0123456789ABCDEF';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(lx - 2, ly - 2, sw * 16 + 4, hh + 4);
  for (let q = 0; q < 16; q++) {
    ctx.fillStyle = PALETTE[q];
    ctx.fillRect(lx + q * sw, ly, sw, hh);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(hex[q], lx + q * sw + 3, ly + 10);
  }

  // 原点マーカー(左上の L 字)。物差し自体がずれていないかを見るためのもの
  ctx.strokeStyle = 'rgba(255,45,85,1)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(16, 0);
  ctx.moveTo(0, 0); ctx.lineTo(0, 16);
  ctx.stroke();
  return true;
}

/**
 * 見えているビューポートの大きさ。
 * 縦書きで横にスクロールする本では `innerWidth` が版面の幅(大きい値)を返すので、
 * `visualViewport` があればそちらを使う。
 */
export function visibleViewport(win) {
  const vv = win.visualViewport;
  return {
    w: Math.round(vv ? vv.width : win.innerWidth),
    h: Math.round(vv ? vv.height : win.innerHeight),
  };
}

/**
 * いま見えている面の画像と本文の位置を測って返す(§14.4)。
 * 物差しを出していなくても数は返る。描くことと測ることは別である。
 *
 * **座標は物差しと同じ枠で返す。** 本文は `iframe` の中にあるので、その中で測った値は
 * `iframe` の左上が原点になる。物差しは窓に敷いてあるので原点が違う。
 * そこで `origin`（`iframe` の左上が窓のどこに在るか）を足して、窓の座標へそろえる。
 * こうしないと、写真から読んだ色と、ここが返す数が食い違う。
 *
 * **固定レイアウトの本では、枠に倍率が掛かっている。** 窓に合わせて縮めてあるので、
 * 枠の中で測った 600px は窓では 549.5px になる。`scale` はその倍率で、足す前に掛ける。
 *
 * @param origin   本文の枠の左上の、窓の中での位置。既定は {0,0}（ずらさない）
 * @param scale    本文の枠に掛かっている倍率。既定は {x:1, y:1}（等倍）
 * @param viewport 物差しを敷いてある窓の大きさ。省くと `win` の見えている大きさを使う
 */
export function measureDocument(doc, win, {
  origin = { x: 0, y: 0 }, scale = { x: 1, y: 1 }, viewport = null,
} = {}) {
  const vp = viewport || visibleViewport(win);
  const vw = vp.w, vh = vp.h;
  const ox = origin.x || 0, oy = origin.y || 0;
  const sx = scale.x || 1, sy = scale.y || 1;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    const left = r.left * sx + ox, top = r.top * sy + oy;
    const width = r.width * sx, height = r.height * sy;
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  const els = Array.from(doc.querySelectorAll('img,svg,image'));
  const images = els.map((el) => {
    const r = rectOf(el);
    return {
      tag: el.tagName.toLowerCase(),
      x: r1(r.left), y: r1(r.top), w: r1(r.width), h: r1(r.height),
      right: r1(r.right), bottom: r1(r.bottom),
      gapLeft: r1(r.left), gapRight: r1(vw - r.right),
      gapTop: r1(r.top), gapBottom: r1(vh - r.bottom),
      centerX: r1(r.left + r.width / 2), centerY: r1(r.top + r.height / 2),
      leftBand: band(r.left), rightBand: band(r.right),
    };
  });
  const b = doc.body ? rectOf(doc.body)
    : { left: 0, top: 0, width: 0, height: 0 };
  return {
    viewport: { w: vw, h: vh, centerX: Math.round(vw / 2), centerY: Math.round(vh / 2) },
    imageOnlyPage: !!doc.body?.hasAttribute?.('data-image-page'),
    body: { x: r1(b.left), y: r1(b.top), w: r1(b.width), h: r1(b.height) },
    images,
  };
}

// ---------------------------------------------------------------------------
// 層の出し入れ
// ---------------------------------------------------------------------------

/** 物差しの canvas に付ける id。窓の層でも本文の層でも同じものを使う。 */
export const OVERLAY_ID = '__epub_measure_overlay__';

/**
 * その document の一番上に物差しを描く。既に出ていれば描き直す。
 *
 * **縦書きで必ず踏む罠（仕様書 §14.3）**: WebKit は縦書き右綴じのとき、
 * `position: fixed; left: 0` を画面の左端ではなく `html` の左端に合わせる。
 * 縦書きでは `html` が右に寄っているので、物差しが右へずれる。
 * だから **いったん置いてから実際の着地点を測り、その分だけ負にずらす。**
 * こうすると canvas の (x, y) と `getBoundingClientRect()` の (x, y) が一致し、
 * 目で読んだ色と `measureDocument` が返す数が同じ座標系になる。
 */
export function showMeasureOverlay(doc, win = doc?.defaultView) {
  if (!doc || !win) return null;
  hideMeasureOverlay(doc);
  const dpr = win.devicePixelRatio || 1;
  const { w: W, h: H } = visibleViewport(win);
  if (!(W > 1) || !(H > 1)) return null;

  const cv = doc.createElement('canvas');
  cv.id = OVERLAY_ID;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  // canvas 自身に横書きを明示する。書かないと canvas まで縦書きの影響を受ける。
  cv.style.cssText = 'position:fixed;left:0px;top:0px;'
    + `width:${W}px;height:${H}px;`
    + 'z-index:2147483647;pointer-events:none;margin:0;padding:0;'
    + 'writing-mode:horizontal-tb;direction:ltr;';
  (doc.documentElement || doc.body).appendChild(cv);

  const land = cv.getBoundingClientRect();
  cv.style.left = `${-land.left}px`;
  cv.style.top = `${-land.top}px`;

  const ctx = cv.getContext('2d');
  if (!ctx) { cv.remove(); return null; }
  ctx.scale(dpr, dpr);
  drawMeasureGrid(ctx, W, H);
  return cv;
}

/** 物差しを消す。出ていなければ false を返す。 */
export function hideMeasureOverlay(doc) {
  const el = doc?.getElementById?.(OVERLAY_ID);
  if (el) { el.remove(); return true; }
  return false;
}

/** いま物差しが出ているか。 */
export function isMeasureOverlayShown(doc) {
  return !!doc?.getElementById?.(OVERLAY_ID);
}

/** その色に、いちばん近いパレットの番号と、どれだけ離れているかを返す。 */
export function nearestPalette([r, g, b]) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const h = PALETTE[i];
    const pr = parseInt(h.slice(1, 3), 16);
    const pg = parseInt(h.slice(3, 5), 16);
    const pb = parseInt(h.slice(5, 7), 16);
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return { index: best, distance: Math.round(Math.sqrt(bestD) * 10) / 10 };
}

/**
 * **物差しに描いた色を読み戻して、セル番号に直す。**
 * 人が写真を見て色から座標を読むのと、同じことを機械で行う。
 * 読んだ番号と `band()` が返す番号が一致すれば、**物差しはずれていない。**
 *
 * `x` を渡すと上辺（横の座標）、`y` を渡すと左辺（縦の座標）を読む。
 */
export function readRibbon(doc, { x = null, y = null } = {}) {
  const cv = doc?.getElementById?.(OVERLAY_ID);
  if (!cv) return { error: 'no overlay' };
  const ctx = cv.getContext('2d');
  if (!ctx) return { error: 'no context' };
  const cssW = parseFloat(cv.style.width) || cv.width;
  const dpr = cv.width / cssW;
  const pick = (px, py) => {
    const d = ctx.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
    return nearestPalette([d[0], d[1], d[2]]);
  };
  const half = CELL / 2;
  const along = x != null ? x : y;
  const contain0 = Math.floor(along / CELL);
  // **マスの真ん中で読む。** 16 マスごとの黒い境界線が、マスの継ぎ目に引いてあるので、
  // 指定された座標そのままで読むと、線の色が混ざって別の色に見える。
  const center = contain0 * CELL + half;
  // **左上の 20x20 は、左辺のリボンが上辺のリボンを上書きしている**（描く順番による）。
  // つまり x が 20 未満のところで横の座標は読めない。縦も同じ。
  if (along < CELL * 2) {
    return { axis: x != null ? 'x' : 'y', at: along, covered: true, match: null,
      containCell: contain0, roundedCell: band(along).cell };
  }
  const low = x != null ? pick(center, half) : pick(half, center);
  const high = x != null ? pick(center, CELL + half) : pick(CELL + half, center);
  const read = high.index * 16 + low.index;
  // **リボンが示すのは「その点が入っているマス」なので floor で数える。**
  // band() は報告用に四捨五入するので、マスの境目の半分以内では 1 つ違う。
  // 例: x=155 は 15 番のマスの中に在るが、band(155) は 16 を返す。どちらも正しい。
  const contain = contain0;
  return {
    axis: x != null ? 'x' : 'y',
    at: along,
    covered: false,
    low: low.index, high: high.index,
    readCell: read, readPx: read * CELL,
    containCell: contain,
    match: read === contain,
    roundedCell: band(along).cell,      // 測定 API が報告に使う値(四捨五入)
    // 色がどれだけ離れていたか。大きいと、そこはリボンではなく別のものを読んでいる
    distance: Math.max(low.distance, high.distance),
  };
}

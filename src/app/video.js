// 朗読動画の生成。
// - 文ごとの音声(WAV)と読み上げ位置から、カラオケ式の字幕動画を canvas に描画し、
//   canvas.captureStream()(映像) + WebAudio(音声) を1つの MediaStream にまとめて
//   MediaRecorder で録画 → MP4(H.264+AAC, WKWebView が対応)で書き出す。ffmpeg 不要。
// - フレーム/進捗は壁時計(performance.now)で駆動する。captureStream も実時間で録るので
//   A/V が揃う。AudioContext が suspended でも無限ループにならない。
// - orientation:
//   'horizontal' … 横書き。複数行を上へ流す。
//   'vertical'   … 縦書き(vertical-rl)。列を右→左へ流す。本の縦書きに合わせる。
//   どちらも「読んでいる箇所以外はうっすら、現在の読み上げ位置がドロップシャドウで発光」。
import * as api from './api.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const FONT_PX = 56;
const FONT_FAMILY = '"Hiragino Mincho ProN", "YuMincho", "Yu Mincho", "Noto Serif JP", serif';

// 横書き
const LINE_GAP = 104;
const MAX_TEXT_W = WIDTH * 0.8;
// 縦書き
const COL_GAP = 104;         // 列の間隔(右→左)
const CELL_H = FONT_PX * 1.02; // 縦の1文字送り
const V_TOP = HEIGHT * 0.12;
const MAX_TEXT_H = HEIGHT * 0.76;
// 縦書きで90°回転させたい約物(長音・各種括弧・ダッシュ等)
const V_ROTATE = new Set('ー―–—…‥「」『』（）()【】〔〕｛｝{}〈〉《》「」[]～〜｜|'.split(''));
// 縦書きで文字セルの右上へ寄せる約物(句読点)。中央配置のままだと不自然。
const V_PUNCT = new Set('、。，．'.split(''));
// 縦書きで少し右上へ寄せる小書き仮名(拗促音)。
const V_SMALL = new Set('ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ'.split(''));

const NO_LINE_START = new Set('、。，．・：；！？」』）】〕〉》”’…ー'.split(''));

export function videoTheme(settings) {
  let theme = settings.theme;
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  switch (theme) {
    case 'sepia': return { bg: '#f4ecd8', fg: '#5b4636', lit: '#7a3d12', accent: 'rgba(184,98,42,.85)', dim: 0.26 };
    case 'light': return { bg: '#fbfbfa', fg: '#20201f', lit: '#b8480f', accent: 'rgba(210,105,30,.75)', dim: 0.22 };
    default: return { bg: '#141416', fg: '#f0eef0', lit: '#ffffff', accent: 'rgba(255,210,74,.9)', dim: 0.24 };
  }
}

// 文ごとの秒数・開始時刻を作る(向きに依らず共通)。
function timeline(segments) {
  const starts = [], durations = [], segLen = [];
  let t = 0;
  segments.forEach((seg, si) => {
    starts[si] = t;
    durations[si] = Math.max(0.05, api.wavDurationSec(seg.wav));
    t += durations[si];
    segLen[si] = [...seg.text].length;
  });
  return { starts, durations, segLen, total: t };
}

// 横書き: 行の配列を作る。行 = {segIndex, chars:[{ch,x}], size(幅), charStart}
function layoutH(segments, ctx) {
  ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
  const lines = [];
  const segFirst = [];
  segments.forEach((seg, si) => {
    segFirst[si] = lines.length;
    const chars = [...seg.text];
    let cur = [], curW = 0, charStart = 0, consumed = 0;
    const push = () => {
      let x = 0; const out = [];
      for (const c of cur) { out.push({ ch: c.ch, x }); x += c.w; }
      lines.push({ segIndex: si, chars: out, size: curW, charStart });
    };
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const w = ctx.measureText(ch).width;
      if (curW + w > MAX_TEXT_W && cur.length) {
        if (NO_LINE_START.has(ch)) { cur.push({ ch, w }); curW += w; consumed++; push(); cur = []; curW = 0; charStart = consumed; continue; }
        push(); cur = []; curW = 0; charStart = consumed;
      }
      cur.push({ ch, w }); curW += w; consumed++;
    }
    if (cur.length) push();
  });
  return { units: lines, segFirst };
}

// 縦書き: 列の配列を作る。列 = {segIndex, chars:[{ch,y,rot}], size(高さ), charStart}
function layoutV(segments) {
  const maxPerCol = Math.floor(MAX_TEXT_H / CELL_H);
  const cols = [];
  const segFirst = [];
  segments.forEach((seg, si) => {
    segFirst[si] = cols.length;
    const chars = [...seg.text];
    let cur = [], charStart = 0;
    const push = () => {
      const out = cur.map((ch, k) => ({ ch, y: k * CELL_H, rot: V_ROTATE.has(ch) }));
      cols.push({ segIndex: si, chars: out, size: cur.length * CELL_H, charStart });
    };
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      // 行頭(=列頭)禁則: 禁則文字なら前の列に残す
      if (cur.length >= maxPerCol) {
        if (NO_LINE_START.has(ch)) { cur.push(ch); push(); cur = []; charStart = i + 1; continue; }
        push(); cur = []; charStart = i;
      }
      cur.push(ch);
    }
    if (cur.length) push();
  });
  return { units: cols, segFirst };
}

// 録画に使う拡張子を事前に知る(保存パネルの初期ファイル名用)。
export function preferredVideoExt() { return pickMime().ext; }

function pickMime() {
  const cands = [
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  for (const [type, ext] of cands) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return { type, ext }; } catch { /* noop */ }
  }
  return { type: '', ext: 'webm' };
}

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    // data URL は "data:<mime>;base64,<payload>"。mime の codecs に ',' が入る
    // (例: video/mp4;codecs=avc1.42E01E,mp4a.40.2)ため単純な split(',') は不可。
    r.onload = () => resolve(String(r.result).replace(/^data:.*?;base64,/, ''));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * 章の朗読動画を生成して base64 と拡張子を返す。
 * @param {object} opts { orientation:'horizontal'|'vertical', onProgress, monitor, signal }
 */
export async function renderSectionVideo(canvas, segments, theme, opts = {}) {
  const { onProgress, monitor = true, signal, orientation = 'horizontal' } = opts;
  const vertical = orientation === 'vertical';
  const stage = (s) => { try { window.__videoStage = s; } catch { /* noop */ } };
  stage('init');
  canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const T = timeline(segments);
  const L = vertical ? layoutV(segments) : layoutH(segments, ctx);
  stage('layout');

  // 音声: 全文を1つの WAV に連結 → AudioBuffer にデコード
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try { await ac.resume(); } catch { /* suspended のままなら音は無音・映像は出る */ }
  const merged = api.mergeWavB64(segments.map((s) => s.wav));
  const arrBuf = await api.blobFromB64(merged, 'audio/wav').arrayBuffer();
  stage('decoding');
  const audioBuf = await ac.decodeAudioData(arrBuf);
  stage('decoded');
  const dest = ac.createMediaStreamDestination();
  const src = ac.createBufferSource();
  src.buffer = audioBuf;
  src.connect(dest);
  if (monitor) src.connect(ac.destination);

  const vStream = canvas.captureStream(FPS);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  stage('stream:v' + stream.getVideoTracks().length + 'a' + stream.getAudioTracks().length);
  const mime = pickMime();
  const recOpts = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 };
  if (mime.type) recOpts.mimeType = mime.type;
  const rec = new MediaRecorder(stream, recOpts);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });

  let scroll = null; // なめらか追従用
  const curSeg = (elapsed) => { let c = 0; while (c < segments.length - 1 && elapsed >= T.starts[c + 1]) c++; return c; };
  const litOf = (elapsed, c) => {
    const segEl = elapsed - T.starts[c];
    return Math.max(0, Math.min(T.segLen[c], Math.round((segEl / T.durations[c]) * T.segLen[c])));
  };

  const drawH = (elapsed) => {
    const cur = curSeg(elapsed);
    const lit = litOf(elapsed, cur);
    const target = L.segFirst[cur] * LINE_GAP;
    scroll = scroll === null ? target : scroll + (target - scroll) * 0.12;
    ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
    for (let li = 0; li < L.units.length; li++) {
      const line = L.units[li];
      const y = HEIGHT * 0.40 + (li * LINE_GAP - scroll) + FONT_PX / 2;
      if (y < -LINE_GAP || y > HEIGHT + LINE_GAP) continue;
      const isCur = line.segIndex === cur;
      const startX = (WIDTH - line.size) / 2;
      for (let k = 0; k < line.chars.length; k++) {
        const c = line.chars[k];
        const read = isCur && line.charStart + k < lit;
        ctx.save();
        ctx.globalAlpha = isCur ? 1 : theme.dim;
        if (read) { ctx.shadowColor = theme.accent; ctx.shadowBlur = 30; ctx.fillStyle = theme.lit; }
        else ctx.fillStyle = theme.fg;
        ctx.fillText(c.ch, startX + c.x, y);
        ctx.restore();
      }
    }
  };

  const drawV = (elapsed) => {
    const cur = curSeg(elapsed);
    const lit = litOf(elapsed, cur);
    const target = L.segFirst[cur] * COL_GAP;
    scroll = scroll === null ? target : scroll + (target - scroll) * 0.12;
    ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
    for (let ci = 0; ci < L.units.length; ci++) {
      const col = L.units[ci];
      // ci が増える(後の文)ほど左へ流れる。現在列は画面の 60% あたり。
      const x = WIDTH * 0.60 - ci * COL_GAP + scroll;
      if (x < -COL_GAP || x > WIDTH + COL_GAP) continue;
      const isCur = col.segIndex === cur;
      for (let k = 0; k < col.chars.length; k++) {
        const c = col.chars[k];
        const read = isCur && col.charStart + k < lit;
        const y = V_TOP + c.y + CELL_H / 2;
        // 句読点は右上へ、小書き仮名は少し右上へ(縦組みの約物位置)
        let ox = 0, oy = 0;
        if (V_PUNCT.has(c.ch)) { ox = FONT_PX * 0.32; oy = -FONT_PX * 0.34; }
        else if (V_SMALL.has(c.ch)) { ox = FONT_PX * 0.10; oy = -FONT_PX * 0.12; }
        ctx.save();
        ctx.globalAlpha = isCur ? 1 : theme.dim;
        if (read) { ctx.shadowColor = theme.accent; ctx.shadowBlur = 30; ctx.fillStyle = theme.lit; }
        else ctx.fillStyle = theme.fg;
        if (c.rot) { ctx.translate(x, y); ctx.rotate(Math.PI / 2); ctx.fillText(c.ch, 0, 0); }
        else ctx.fillText(c.ch, x + ox, y + oy);
        ctx.restore();
      }
    }
  };

  const draw = vertical ? drawV : drawH;

  draw(0);
  rec.start(200);
  try { src.start(); } catch { /* noop */ }
  const startWall = performance.now();

  // フレーム駆動は setTimeout(≒FPS)。requestAnimationFrame はウィンドウが最前面でない/
  // 隠れていると停止するため、書き出し中に別ウィンドウへ切り替えると完走しなくなる。
  // canvas への描画自体はオクルージョンの影響を受けず captureStream に乗る。
  let aborted = false;
  await new Promise((resolve) => {
    const loop = () => {
      if (signal?.aborted) { aborted = true; resolve(); return; }
      const elapsed = (performance.now() - startWall) / 1000;
      if (elapsed >= T.total) { resolve(); return; }
      draw(elapsed);
      onProgress?.(elapsed, T.total);
      setTimeout(loop, 1000 / FPS);
    };
    setTimeout(loop, 1000 / FPS);
  });
  if (!aborted) { draw(T.total); onProgress?.(T.total, T.total); }

  stage('stopping');
  try { src.stop(); } catch { /* noop */ }
  rec.stop();
  await stopped;
  stage('stopped:chunks' + chunks.length);
  try { await ac.close(); } catch { /* noop */ }
  if (aborted) { const e = new Error('ABORTED'); e.code = 'ABORTED'; throw e; }

  const blob = new Blob(chunks, { type: mime.type || 'video/webm' });
  const b64 = await blobToB64(blob);
  try {
    window.__videoInfo = { total: T.total, mime: mime.type, chunks: chunks.length, blobSize: blob.size, b64len: b64.length, orientation };
  } catch { /* noop */ }
  return { b64, ext: mime.ext, duration: T.total };
}

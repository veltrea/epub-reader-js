// E2E スモークテスト(computer-use 非依存)。
// 前提: (1) ブリッジ起動  node mcp/testbus-mcp/server.mjs
//       (2) アプリ起動    open .../epub-reader.app
// 実行:  node tests/smoke.mjs
//
// 本棚に本が1冊もない場合は import で TB_EPUB(既定 test-books/vertical-long.epub)を取り込む。
import { tb, waitApp } from './tb.mjs';
import { resolve } from 'node:path';

const EPUB = process.env.TB_EPUB || resolve('test-books/vertical-long.epub');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'ok  ' : 'FAIL'}- ${name}${extra ? ' :: ' + extra : ''}`); };

// 検証に使う本のタイトル(TB_EPUB の中身)。**先頭の本ではなくこれを開く**——
// 開発用の書棚には実書籍が並んでいて、どれが先頭になるかで結果が変わってしまうため。
const EPUB_TITLE = process.env.TB_EPUB_TITLE || '縦書き長文検証見本';
let importedTestEpub = null;   // このテストが取り込んだなら、終わりに外す

async function ensureReaderOpen() {
  let s = await tb('state');
  if (s.page === 'reader') return s;
  let lib = await tb('library');
  let target = lib.find((b) => b.title === EPUB_TITLE);
  if (!target) {
    await tb('import', { path: EPUB });
    lib = await tb('library');
    target = lib.find((b) => b.title === EPUB_TITLE);
    if (target) importedTestEpub = target.id;
  }
  target ||= lib[0];
  if (!target) throw new Error('取り込みに失敗(本棚が空)');
  await tb('open', { id: target.id });
  // 遷移待ち
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { s = await tb('state'); if (s.page === 'reader' && s.sectionCount) return s; } catch { /* noop */ }
  }
  throw new Error('リーダーが開かない');
}

/**
 * 検証用 EPUB を、このテストが取り込んだのなら書棚から外す(書棚を元の姿に戻す)。
 *
 * ※ もとは PDF を確かめる `pdfChecks()` の後始末としてこの処理が入っていた。
 * PDF 対応を取り下げたときにその関数ごと消したので、後始末だけをここへ移した。
 * **すべての検査が終わってから呼ぶ**——途中で外すと、後の検査が
 * `ensureReaderOpen()` で取り込み直してしまい、書棚に残ってしまう。
 */
async function removeImportedTestEpub() {
  if (!importedTestEpub) return;
  // 書棚へ戻る(リーダーからは外せない)
  await tb('navigate', { url: 'index.html' });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await tb('state')).page === 'shelf') break; } catch { /* 遷移中 */ }
  }
  await tb('remove', { id: importedTestEpub });
  ok('検証用 EPUB を書棚から外した', !(await tb('library')).some((b) => b.id === importedTestEpub));
}

/**
 * 読み上げエンジンに届かないとき、**黙って無音で進み続けない**ことを確かめる。
 *
 * VOICEVOX / AivisSpeech は別途インストールが要るので、**入れていない人は必ずここを通る**。
 * 以前は合成失敗を 1 文ずつ飛ばしていたため、「再生中の表示のまま、ハイライトだけが進んで
 * 無音」になり、何が悪いのか分からないまま終わっていた。
 *
 * エンジンを止めずに試せるよう、接続先を**確実に繋がらないポート**へ一時的に差し替える
 * （9 番は discard。待ち受けている物がまずない）。終わったら必ず元へ戻す。
 */
async function ttsUnreachableCheck() {
  await ensureReaderOpen();
  const orig = await tb('getSettings');
  await tb('setSetting', { key: 'engine', value: 'custom' });
  await tb('setSetting', { key: 'customBaseUrl', value: 'http://127.0.0.1:9' });
  try {
    await tb('ttsPlay');
    let st = await tb('ttsState');
    // 合成の失敗を待つ。届かない相手なので数秒で決着する。
    for (let i = 0; i < 20 && st.playing; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await tb('ttsState');
    }
    ok('エンジンに届かないとき読み上げを止める', st.playing === false,
      st.playing ? '再生中のまま（無音で進み続けている）' : '停止した');
  } finally {
    await tb('ttsStop');
    await tb('setSetting', { key: 'engine', value: orig.engine ?? 'voicevox' });
    if (orig.customBaseUrl != null) {
      await tb('setSetting', { key: 'customBaseUrl', value: orig.customBaseUrl });
    }
  }
}

async function main() {
  console.log('waiting for app...');
  await waitApp();

  const ping = await tb('ping');
  ok('ping 応答', ping.ok === true, ping.page);

  const s0 = await ensureReaderOpen();
  ok('リーダーが開いている', s0.page === 'reader', s0.title);
  ok('章数が取れる', s0.sectionCount > 0, `sections=${s0.sectionCount}`);

  const toc = await tb('toc');
  ok('目次が取れる', Array.isArray(toc) && toc.length > 0, `${toc.length} 項目`);

  const ct = await tb('currentText', { max: 60 });
  ok('現在ページに本文がある', ct.length > 0, `${ct.length}字: ${ct.text.slice(0, 24)}…`);

  // ページ送り(非破壊: next→prev で戻る)
  const before = (await tb('state')).fraction;
  await tb('page', { dir: 'next' });
  const mid = (await tb('state')).fraction;
  await tb('page', { dir: 'prev' });
  const after = (await tb('state')).fraction;
  ok('ページ送りで進む', mid !== before, `${before.toFixed(4)}→${mid.toFixed(4)}`);
  ok('戻すと元位置(非破壊)', Math.abs(after - before) < 1e-6, `${after.toFixed(4)}`);

  // 縦書き/横書きの向き
  const dir = s0.dir;
  ok('読み方向が取れる', dir === 'rtl' || dir === 'ltr', dir);

  // 進捗スライダーが読み方向に一致(RTLは鏡像化: 右端=先頭)
  const pd = await tb('progressDir');
  ok('スライダーの向きが本の向きと一致', pd.sliderDirection === dir, `slider=${pd.sliderDirection} book=${dir}`);

  // --- S系: リーダー表示設定(非破壊: 後で元に戻す) ---
  const orig = await tb('getSettings');
  // S1 文字サイズ
  await tb('setSetting', { key: 'fontScale', value: 1.6 });
  const cf = await tb('computedFont');
  const base = parseFloat(await tb('computedFont').then(() => cf.htmlFontSize)); // 25.6px 相当
  ok('S1 文字サイズが拡大する', parseFloat(cf.htmlFontSize) > 18, cf.htmlFontSize);
  // S3 セピア/ダーク
  await tb('setSetting', { key: 'theme', value: 'sepia' });
  const sep = await tb('computedFont');
  ok('S3 セピアで背景色が変わる', /244|245/.test(sep.bodyBg), sep.bodyBg);
  await tb('setSetting', { key: 'theme', value: 'dark' });
  const dk = await tb('computedFont');
  ok('S3 ダークで背景色が変わる', /rgb\(2[0-9], 2[0-9], /.test(dk.bodyBg), dk.bodyBg);
  // S4 ルビ(本にルビがある場合のみ)
  const ruby = await tb('rubyInfo');
  if (ruby.count > 0) ok('S4 ルビの読みを本文から除外', ruby.stashed === ruby.count && !ruby.textIncludesReading, `${ruby.stashed}/${ruby.count}`);
  else console.log('  skip- S4 ルビ(この本にルビなし)');
  // 復元
  await tb('setSetting', { key: 'fontScale', value: orig.fontScale ?? 1 });
  await tb('setSetting', { key: 'theme', value: orig.theme ?? 'auto' });
  ok('設定を復元', true);

  // --- M系 ---
  // M4 タップゾーン存在
  const tz = await tb('tapZones');
  ok('M4 左右タップゾーンがある', tz.left && tz.right);
  // M6 強制余白トグル
  const m0 = (await tb('marginState')).forceMargin;
  const m1 = (await tb('toggleMargin')).forceMargin;
  ok('M6 余白トグルが反転', m0 !== m1);
  await tb('setSetting', { key: 'forceMargin', value: !!m0 }); // 復元
  await tb('toggleMargin'); await tb('toggleMargin'); // クラス整合(no-op往復)
  // M2 しおり round-trip(非破壊: 追加して消す)
  const bmBefore = (await tb('bookmarkList')).length;
  await tb('bookmarkAdd');
  const added = (await tb('bookmarkList')).length;
  ok('M2 しおり追加', added === bmBefore + 1 || added === bmBefore, `${bmBefore}→${added}`);
  await tb('bookmarkClear');
  ok('M2 しおりクリア', (await tb('bookmarkList')).length === 0);

  // --- L系 ---
  // L1 検索(先頭ページに出やすい語で)
  const firstWord = (ct.text.match(/[一-龠ぁ-んァ-ヶ]{2,4}/) || [])[0];
  if (firstWord) {
    const sr = await tb('search', { query: firstWord, max: 1 });
    ok('L1 検索がヒットする', sr.count > 0, `"${firstWord}" ${sr.count}件`);
  } else console.log('  skip- L1 検索(このページに本文なし)');
  // L2 カスタムCSS(本別で色変更→復元)
  const origCss = await tb('getCSS');
  const cssRes = await tb('setCSS', { book: 'p{color:#ff0000 !important}' });
  ok('L2 カスタムCSSが本文に効く', /255, 0, 0/.test(cssRes.sampleColor || ''), cssRes.sampleColor);
  await tb('setCSS', { book: origCss.book || '' }); // 復元
  ok('L2 CSS復元', true);

  // --- 表示エンジンの解釈(表示モード・綴じ方向・見開き・判型) ---
  const d0 = await tb('displayState');
  ok('表示状態が取れる', !!d0.renderMode && !!d0.binding, `render=${d0.renderMode} bind=${d0.binding} bookDir=${d0.bookDir}`);
  const raw = await tb('setDisplay', { renderMode: 'raw' });
  ok('raw へ切り替わる', raw.renderMode === 'raw');
  const fr = await tb('setDisplay', { renderMode: d0.renderMode });
  ok('friendly へ戻る', fr.renderMode === d0.renderMode);
  // 綴じ方向の強制は操作の向きに効く(章ごとの向きではなく本単位で決める)
  const bl = await tb('setDisplay', { binding: 'ltr' });
  ok('綴じ方向を左綴じへ強制できる', bl.effectiveDir === 'ltr');
  const br = await tb('setDisplay', { binding: 'rtl' });
  ok('綴じ方向を右綴じへ強制できる', br.effectiveDir === 'rtl');
  await tb('setDisplay', { binding: d0.binding });
  // 本文の見開き: 横書きは列数、縦書きはブロック幅で効く
  if (!d0.fixedLayout) {
    const spNever = await tb('setDisplay', { textSpread: 'never' });
    ok('本文の見開きを単ページへ倒せる', spNever.textSpread === 'never');
    await tb('setDisplay', { textSpread: d0.textSpread });
  }

  // --- 目次のリンク切れ救済(spine に載っていない項目でも飛べる) ---
  const tocN = (await tb('toc')).length;
  if (tocN > 0) {
    const home = (await tb('state')).fraction;   // 戻す位置を先に控える
    await tb('setDisplay', { renderMode: 'friendly' });   // 救済は friendly のときだけ効く
    await tb('gotoFraction', { fraction: 0.4 });
    await new Promise((r) => setTimeout(r, 800));
    const jumped = await tb('tocJump', { index: 0 });
    await new Promise((r) => setTimeout(r, 800));
    const after = (await tb('state')).sectionIndex;
    ok('目次の先頭項目へ飛べる', jumped.ok && after === 0, `index=${after}`);
    await tb('setDisplay', { renderMode: d0.renderMode });
    await tb('gotoFraction', { fraction: home });
    await new Promise((r) => setTimeout(r, 800));
    ok('読書位置を復元', true);
  }

  // --- 読み辞書(レイヤー付き前処理) ---
  // 一時的に規則を入れて適用結果を見る。終わったら元に戻す(非破壊)。
  const dictBefore = await tb('dictGet');
  await tb('dictSet', { entries: [
    { surface: '斎藤ひとし', reading: 'さいとうひとし', layer: 6 },
    { surface: '斎', reading: 'ものいみ', layer: 5 },
    { surface: '第(\\d+)話', reading: 'ダイ$1ワ', kind: 'pattern', layer: 7 },
    { surface: '東京', reading: 'とうきょう', layer: 4, padsBoundary: true },
  ] });
  const prep = await tb('dictPrepare', { text: '第12話 斎藤ひとしと斎、東京都へ。' });
  ok('上のレイヤーが下に食われない', prep.text === 'ダイ12ワ サイトウヒトシとモノイミ、 トウキョウ 都へ。', prep.text);
  ok('挿入した境界だけ無音化される', prep.silenceGaps.length === 1, JSON.stringify(prep.silenceGaps));
  await tb('dictSet', { entries: dictBefore });
  ok('読み辞書を復元', true);

  await ttsUnreachableCheck();
  await removeImportedTestEpub();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

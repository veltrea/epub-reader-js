// 設定モーダルと辞書モーダル(本棚・リーダー共用)。
import * as api from './api.js';
import {
  ENGINES, engineBaseUrl, saveSettings, loadDict, saveDict,
  loadTranslationCache, saveTranslationCache,
} from './store.js';
import { normalizeList, prepare, isValidPattern } from './dictionary.js';
import { DEFAULT_TRANSLATION, LANGS as TR_LANGS, probeModels } from './translate.js';
import { t } from './i18n.js';

/**
 * 設定の「テーマ」は**本文だけ**に効く。アプリの地・ツールバー・シートの配色は
 * システムの外観(ライト/ダーク)に従う——Swift 版が preferredColorScheme を
 * 指定していない＝アプリの見た目はシステム追従で、theme は本文へ注入する CSS の
 * ためだけにあるので、そこに合わせる。
 * 値は本文の CSS を組む側(reader.js の readerCSS)が読む。ここでは印だけ残す。
 */
export function applyTheme(theme) {
  document.documentElement.dataset.bookTheme = theme || 'auto';
}

function modalShell(html) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop show';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  function close() { back.remove(); }
  return { back, close, modal: back.querySelector('.modal') };
}

// ---------------- 設定 ----------------
// 見た目の基準は Swift 版 SettingsView.swift。
// シートの上端に「閉じる / テスト再生・保存」、その下に大きな見出し、
// 「読み上げ / 表示」のセグメント、以下はグループ化リスト。
export function openSettings(settings, onSaved, { onCacheCleared } = {}) {
  const s = { ...settings };
  const row = (label, body) => `<div class="row"><label>${label}</label>${body}</div>`;
  const slider = (id, min, max, step) =>
    `<input id="${id}" class="grow" type="range" min="${min}" max="${max}" step="${step}">
     <span class="value" id="${id}-v" style="min-width:3.2ch"></span>`;
  const picker = (id, opts) =>
    `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  const check = (id) =>
    `<input id="${id}" type="checkbox" style="width:auto;margin-inline-start:auto">`;
  // 対訳の言語選択。訳文側に「自動判定」は置かない(原文の言語へ訳す指示になってしまう)。
  const trLangs = (withAuto) => Object.keys(TR_LANGS)
    .filter((k) => withAuto || k !== 'auto')
    .map((k) => [k, t(`settings.tr.lang.${k}`)]);
  const tr0 = { ...DEFAULT_TRANSLATION, ...(s.translation || {}) };

  const { modal, close } = modalShell(`
    <div class="sheet-bar">
      <button id="st-cancel">${t('settings.close')}</button>
      <span class="grow"></span>
      <button id="st-test">${t('settings.testVoice')}</button>
      <button id="st-save">${t('settings.save')}</button>
    </div>
    <h2>${t('settings.title')}</h2>
    <div class="modal-body">
      <div class="segmented" id="st-tabs" style="display:flex;width:100%;margin-bottom:16px">
        <button data-tab="tts" class="on grow" style="flex:1">${t('settings.tab.tts')}</button>
        <button data-tab="display" class="grow" style="flex:1">${t('settings.tab.display')}</button>
        <button data-tab="translate" class="grow" style="flex:1">${t('settings.tab.translate')}</button>
      </div>

      <div id="st-pane-tts">
        <div class="group">
          ${row(t('settings.engine'), picker('st-engine', [
            ['voicevox', t('settings.engine.voicevox')],
            ['aivis', t('settings.engine.aivis')],
            ['custom', t('settings.engine.custom')]]))}
          <div class="row" id="st-custom-row">
            <input id="st-custom" class="grow" type="text" placeholder="http://127.0.0.1:50021"></div>
          <div class="row"><label>${t('settings.engineStatus')}</label>
            <span class="value"><span id="st-dot" class="status-dot"></span><span id="st-status">…</span></span>
            <button id="st-recheck" class="icon" title="recheck">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/></svg>
            </button></div>
        </div>
        <div class="group">
          ${row(t('settings.speaker'), `<select id="st-speaker"></select>`)}
          ${row(t('settings.speed'), slider('st-speed', 0.5, 2, 0.05))}
          ${row(t('settings.pause'), slider('st-pause', 0, 3, 0.1))}
        </div>
        <div class="group">
          <div class="row"><label>${t('settings.saveDir')}</label>
            <span class="value" id="st-savedir-label"></span>
            <button id="st-savedir-pick" class="bordered">${t('settings.saveDir.browse')}</button>
            <input id="st-savedir" type="hidden"></div>
        </div>
      </div>

      <div id="st-pane-display" hidden>
        <div class="group">
          ${row(t('settings.fontSize'), slider('st-font', 0.6, 2.5, 0.1))}
          ${row(t('settings.lineHeight'), slider('st-lh', 1.2, 2.6, 0.1))}
          ${row(t('settings.theme'), picker('st-theme', [
            ['auto', t('settings.theme.auto')], ['light', t('settings.theme.light')],
            ['sepia', t('settings.theme.sepia')], ['dark', t('settings.theme.dark')]]))}
          ${row(t('common.language'), picker('st-lang', [['auto', 'Auto'], ['ja', '日本語'], ['en', 'English']]))}
          ${row(t('settings.writing'), picker('st-writing', [
            ['auto', t('settings.writing.auto')], ['vertical', t('settings.writing.vertical')],
            ['horizontal', t('settings.writing.horizontal')]]))}
          ${row(t('settings.render'), picker('st-render', [
            ['friendly', t('menu.value.friendly')], ['raw', t('menu.value.raw')]]))}
          ${row(t('settings.binding'), picker('st-binding', [
            ['auto', t('menu.value.auto')], ['rtl', t('menu.value.rtl')], ['ltr', t('menu.value.ltr')]]))}
          ${row(t('settings.imageSpread'), picker('st-imgspread', [
            ['auto', t('settings.spread.auto')], ['always', t('settings.spread.always')],
            ['never', t('settings.spread.never')]]))}
          ${row(t('settings.textSpread'), picker('st-textspread', [
            ['auto', t('settings.spread.auto')], ['always', t('settings.spread.always')],
            ['never', t('settings.spread.never')]]))}
        </div>
        <div class="desc" style="padding:0 4px 16px">${t('settings.displayDesc')}</div>
      </div>

      <div id="st-pane-translate" hidden>
        <div class="group">
          <div class="row"><label>${t('settings.tr.baseUrl')}</label>
            <input id="st-tr-url" class="grow" type="text" placeholder="http://127.0.0.1:1234"></div>
          <div class="row"><label>${t('settings.tr.apiKey')}</label>
            <input id="st-tr-key" class="grow" type="password" autocomplete="off" spellcheck="false"
                   placeholder="${t('settings.tr.apiKeyPh')}"></div>
          <div class="row"><label>${t('settings.tr.status')}</label>
            <span class="value"><span id="st-tr-dot" class="status-dot"></span><span id="st-tr-status">…</span></span>
            <button id="st-tr-recheck" class="icon" title="recheck">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4h-4"/></svg>
            </button></div>
          ${row(t('settings.tr.model'), `<select id="st-tr-model" class="grow"></select>`)}
        </div>
        <div class="group">
          ${row(t('settings.tr.srcLang'), picker('st-tr-src', trLangs(true)))}
          ${row(t('settings.tr.dstLang'), picker('st-tr-dst', trLangs(false)))}
        </div>
        <div class="group">
          ${row(t('settings.tr.temperature'), slider('st-tr-temp', 0, 1, 0.05))}
          ${row(t('settings.tr.concurrency'), slider('st-tr-conc', 1, 8, 1))}
          ${row(t('settings.tr.useContext'), check('st-tr-ctx'))}
          ${row(t('settings.tr.prefill'), check('st-tr-prefill'))}
        </div>
        <div class="group">
          <div class="row"><label>${t('settings.tr.cache')}</label>
            <span class="value" id="st-tr-cache-n"></span>
            <button id="st-tr-cache-clear" class="bordered">${t('settings.tr.cacheClear')}</button></div>
        </div>
        <div class="desc" style="padding:0 4px 8px">${t('settings.tr.prefillDesc')}</div>
        <div class="desc" style="padding:0 4px 16px">${t('settings.tr.desc')}</div>
      </div>
    </div>`);

  const $ = (sel) => modal.querySelector(sel);
  $('#st-engine').value = s.engine;
  $('#st-custom').value = s.customBaseUrl;
  $('#st-speed').value = s.speedScale;
  $('#st-pause').value = s.pauseLengthScale;
  $('#st-theme').value = s.theme;
  $('#st-writing').value = s.writingMode || 'auto';
  $('#st-lang').value = s.lang;
  $('#st-font').value = s.fontScale ?? 1;
  $('#st-lh').value = s.lineHeight ?? 1.8;
  $('#st-savedir').value = s.ttsSaveDir || '';
  $('#st-savedir-label').textContent = s.ttsSaveDir || t('settings.saveDir.unset');
  $('#st-render').value = s.renderMode || 'friendly';
  $('#st-binding').value = s.binding || 'auto';
  $('#st-imgspread').value = s.imageSpread || 'auto';
  $('#st-textspread').value = s.textSpread || 'auto';
  $('#st-tr-url').value = tr0.baseURL || '';
  $('#st-tr-key').value = tr0.apiKey || '';
  $('#st-tr-src').value = tr0.sourceLanguage;
  $('#st-tr-dst').value = tr0.targetLanguage;
  $('#st-tr-temp').value = tr0.temperature;
  $('#st-tr-conc').value = tr0.concurrency;
  $('#st-tr-ctx').checked = !!tr0.useContext;
  $('#st-tr-prefill').checked = !!tr0.prefillThinkClose;

  // スライダーは「読んだ側を塗る」ので、値を CSS へも渡す。
  const syncSlider = (id, digits) => {
    const el = $('#' + id);
    const min = parseFloat(el.min), max = parseFloat(el.max);
    el.style.setProperty('--track-p', String((el.value - min) / (max - min)));
    $('#' + id + '-v').textContent = (+el.value).toFixed(digits);
  };
  for (const [id, d] of [['st-speed', 2], ['st-pause', 1], ['st-font', 1], ['st-lh', 1],
    ['st-tr-temp', 2], ['st-tr-conc', 0]]) {
    syncSlider(id, d);
    $('#' + id).addEventListener('input', () => syncSlider(id, d));
  }

  // 「読み上げ / 表示 / 対訳」タブ
  for (const b of modal.querySelectorAll('#st-tabs button')) {
    b.addEventListener('click', () => {
      for (const o of modal.querySelectorAll('#st-tabs button')) o.classList.toggle('on', o === b);
      const tab = b.dataset.tab;
      $('#st-pane-tts').hidden = tab !== 'tts';
      $('#st-pane-display').hidden = tab !== 'display';
      $('#st-pane-translate').hidden = tab !== 'translate';
      // 「テスト再生」は読み上げの操作なので、対訳・表示では出さない。
      $('#st-test').style.display = tab === 'tts' ? '' : 'none';
      // モデル一覧は開いたときに一度だけ取りに行く(設定を開くたびに毎回叩かない)。
      if (tab === 'translate' && !trProbed) refreshTrModels();
    });
  }

  // URL 欄は常に出し、プリセットを選んでいる間はその接続先を読み取り専用で見せる。
  const syncCustom = () => {
    const custom = $('#st-engine').value === 'custom';
    const box = $('#st-custom');
    box.readOnly = !custom;
    box.style.opacity = custom ? '' : '.6';
    if (!custom) box.value = ENGINES[$('#st-engine').value]?.baseUrl || '';
    else box.value = s.customBaseUrl;
  };
  syncCustom();
  const curBase = () => {
    const eng = $('#st-engine').value;
    if (eng === 'custom') return $('#st-custom').value;
    return ENGINES[eng]?.baseUrl;
  };

  async function refreshEngine() {
    const dot = $('#st-dot'), status = $('#st-status'), sel = $('#st-speaker');
    dot.className = 'status-dot'; status.textContent = '…';
    try {
      const ver = await api.voicevoxVersion(curBase());
      dot.className = 'status-dot ok';
      status.textContent = `${t('settings.connected')} (v${ver})`;
      const speakers = await api.voicevoxSpeakers(curBase());
      sel.innerHTML = '';
      for (const sp of speakers) for (const st of sp.styles) {
        const o = document.createElement('option');
        o.value = st.id; o.textContent = `${sp.name} / ${st.name}`;
        sel.appendChild(o);
      }
      sel.value = s.speaker;
    } catch {
      dot.className = 'status-dot ng';
      status.textContent = t('settings.disconnected');
      sel.innerHTML = `<option value="${s.speaker}">#${s.speaker}</option>`;
    }
  }
  refreshEngine();

  // ---- 対訳: 接続確認とモデル一覧 ----
  // OpenAI 互換なら手元のサーバーでもクラウドでも同じ /v1/models で引ける。
  let trProbed = false;
  async function refreshTrModels() {
    trProbed = true;
    const dot = $('#st-tr-dot'), status = $('#st-tr-status'), sel = $('#st-tr-model');
    // 一覧を取り直しても、いま選ばれているモデルは選び直さずに済むよう覚えておく。
    const want = sel.value || tr0.model || '';
    dot.className = 'status-dot';
    status.textContent = t('settings.tr.probing');
    const fill = (ids) => {
      sel.innerHTML = `<option value="">${t('settings.tr.modelAuto')}</option>`;
      const add = (id) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = id;
        sel.appendChild(o);
      };
      ids.forEach(add);
      // 接続先を変えた直後は保存済みのモデルが一覧に無い。選択そのものは残す。
      if (want && !ids.includes(want)) add(want);
      sel.value = want;
    };
    try {
      const ids = (await probeModels($('#st-tr-url').value.trim(), $('#st-tr-key').value.trim())) || [];
      fill(ids);
      dot.className = `status-dot ${ids.length ? 'ok' : 'ng'}`;
      status.textContent = ids.length
        ? t('settings.tr.probeOk', { n: ids.length })
        : t('settings.tr.probeEmpty');
    } catch {
      fill([]);
      dot.className = 'status-dot ng';
      status.textContent = t('settings.tr.probeFail');
    }
  }
  // 訳のキャッシュ。件数を出し、捨てられるようにする(モデルを変えると古い訳が残るため)。
  const showCacheCount = async () => {
    const n = Object.keys((await loadTranslationCache()) || {}).length;
    $('#st-tr-cache-n').textContent = t('settings.tr.cacheN', { n });
  };
  void showCacheCount();
  $('#st-tr-cache-clear').addEventListener('click', async () => {
    await saveTranslationCache({});
    // リーダーが開いている間は同じ内容をメモリにも持っているので、そちらも捨てさせる。
    // 捨てないと、消したはずの訳がデバウンス書き戻しで復活する。
    onCacheCleared?.();
    await showCacheCount();
  });

  $('#st-tr-recheck').addEventListener('click', refreshTrModels);
  $('#st-tr-url').addEventListener('change', refreshTrModels);
  $('#st-tr-key').addEventListener('change', refreshTrModels);

  $('#st-engine').addEventListener('change', () => { syncCustom(); refreshEngine(); });
  $('#st-custom').addEventListener('change', refreshEngine);
  $('#st-recheck').addEventListener('click', refreshEngine);
  $('#st-savedir-pick').addEventListener('click', async () => {
    const dir = await api.pickDirectory();
    if (dir) { $('#st-savedir').value = dir; $('#st-savedir-label').textContent = dir; }
  });

  const collect = () => ({
    ...s,
    engine: $('#st-engine').value,
    customBaseUrl: $('#st-custom').value || s.customBaseUrl,
    speaker: parseInt($('#st-speaker').value, 10) || s.speaker,
    speedScale: parseFloat($('#st-speed').value),
    pauseLengthScale: parseFloat($('#st-pause').value),
    theme: $('#st-theme').value,
    writingMode: $('#st-writing').value,
    lang: $('#st-lang').value,
    fontScale: parseFloat($('#st-font').value),
    lineHeight: parseFloat($('#st-lh').value),
    ttsSaveDir: $('#st-savedir').value || '',
    renderMode: $('#st-render').value,
    binding: $('#st-binding').value,
    imageSpread: $('#st-imgspread').value,
    textSpread: $('#st-textspread').value,
    translation: {
      ...tr0,
      baseURL: $('#st-tr-url').value.trim() || DEFAULT_TRANSLATION.baseURL,
      apiKey: $('#st-tr-key').value.trim(),
      model: $('#st-tr-model').value,
      sourceLanguage: $('#st-tr-src').value,
      targetLanguage: $('#st-tr-dst').value,
      temperature: parseFloat($('#st-tr-temp').value),
      concurrency: parseInt($('#st-tr-conc').value, 10) || DEFAULT_TRANSLATION.concurrency,
      useContext: $('#st-tr-ctx').checked,
      prefillThinkClose: $('#st-tr-prefill').checked,
    },
  });

  $('#st-test').addEventListener('click', async () => {
    const cur = collect();
    try {
      const b64 = await api.voicevoxSynthesize(engineBaseUrl(cur), t('settings.testVoiceText'), cur.speaker, cur.speedScale, cur.pauseLengthScale);
      new Audio('data:audio/wav;base64,' + b64).play();
    } catch (e) { alert(t('settings.testVoiceFailed', { error: e })); }
  });
  $('#st-cancel').addEventListener('click', close);
  $('#st-save').addEventListener('click', async () => {
    const cur = collect();
    await saveSettings(cur);
    close();
    onSaved?.(cur);
  });
}

// ---------------- 読み上げ辞書(レイヤー付き前処理) ----------------
// 音声エンジンのユーザー辞書は使わない。エンジンの辞書は形態素解析のコストで語を選ぶため、
// 短い登録語(「斎」)が長い熟語(「斎藤」)を食い荒らすのを原理的に防げないため(§10.2)。
//
// 見た目の基準は Swift 版: 一覧は**レイヤーごとの塊**で、行は「表記 → 読み ›」。
// 行を押すと 1 件分の編集画面へ進む(戻るのは左上の ‹)。
export async function openDict(getSettings, { addSurface = '', onClose } = {}) {
  // 保存済みは旧形式(yomi/priority)のこともあるので normalizeList が移行を兼ねる
  let entries = normalizeList(await loadDict());

  const { modal, close } = modalShell(`<div id="dict-root"></div>`);
  const $ = (sel) => modal.querySelector(sel);

  const commit = async () => { entries = normalizeList(entries); await saveDict(entries); };

  // ---- 一覧 ----
  function renderList() {
    const layers = [...new Set(entries.map((e) => e.layer))].sort((a, b) => b - a);
    const groups = layers.map((L) => {
      const rows = entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.layer === L)
        // 実際に適用される順(同一レイヤーは表記の長い順)でそのまま並べる
        .sort((a, b) => b.e.surface.length - a.e.surface.length);
      return `<div class="group-head">${t('dict.layerN', { n: L })}</div>
        <div class="group">${rows.map(({ e, i }) => `
          <button class="row dict-row" data-i="${i}" style="width:100%;text-align:start;${e.enabled ? '' : 'opacity:.5'}">
            <span style="color:var(--fg)">${escapeText(e.surface || t('dict.noSurface'))}</span>
            <span style="color:var(--muted)">→</span>
            <span class="grow" style="color:var(--muted)">${escapeText(e.reading)}</span>
            <span style="color:var(--muted2)">›</span>
          </button>`).join('')}</div>`;
    }).join('');

    $('#dict-root').innerHTML = `
      <div class="sheet-bar"><span class="grow"></span>
        <button id="dict-close">${t('settings.close')}</button></div>
      <h2>${t('dict.title')}</h2>
      <div class="modal-body">
        ${groups || `<div class="desc" style="padding:0 4px 12px">${t('dict.empty')}</div>`}
        <div class="group"><button class="row" id="dict-add" style="width:100%;text-align:start;color:var(--accent)">
          <span style="width:16px;text-align:center">＋</span>
          <span class="grow">${t('dict.add')}</span><span style="color:var(--muted2)">›</span></button></div>
        <div class="desc" style="padding:0 4px 16px">${t('dict.desc')}</div>
        <div class="group-head">${t('dict.test')}</div>
        <div class="group">
          <div class="row"><input id="dict-test" class="grow" style="background:none"
            placeholder="${escAttr(t('dict.testPh'))}"></div>
          <div class="row"><span style="width:16px;color:var(--muted)">🔈</span>
            <span class="grow" id="dict-test-out" style="color:var(--muted)"></span></div>
        </div>
      </div>`;

    for (const b of modal.querySelectorAll('.dict-row')) {
      b.addEventListener('click', () => renderEntry(+b.dataset.i));
    }
    $('#dict-add').addEventListener('click', () => {
      entries.push({ surface: addSurface || '', reading: '', layer: 5, kind: 'word', padsBoundary: false, enabled: true });
      renderEntry(entries.length - 1);
    });
    $('#dict-test').addEventListener('input', runTest);
    $('#dict-close').addEventListener('click', async () => { await commit(); close(); onClose?.(entries); });
    runTest();
  }

  // 「上のレイヤーから順に置き換え、置き換えた部分は下のレイヤーでは触らない」を目で確かめる欄
  function runTest() {
    const src = $('#dict-test')?.value;
    const out = $('#dict-test-out');
    if (!out) return;
    if (!src) { out.textContent = ''; return; }
    const r = prepare(src, entries.filter((e) => e.surface && e.reading));
    out.textContent = r.text + (r.silenceGaps.length ? `  [${t('dict.silenced', { n: r.silenceGaps.length })}]` : '');
  }

  // ---- 1 件分の編集 ----
  function renderEntry(i) {
    const e = entries[i];
    const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}"${on ? ' checked' : ''}>
      <span class="track"></span><span class="knob"></span></label>`;
    $('#dict-root').innerHTML = `
      <div class="sheet-bar">
        <button id="de-back" style="font-size:17px;padding:0 4px">‹</button><span class="grow"></span></div>
      <h2>${t('dict.entryTitle')}</h2>
      <div class="modal-body">
        <div class="segmented" id="de-kind" style="display:flex;width:100%;margin-bottom:16px">
          <button data-kind="word" class="${e.kind === 'word' ? 'on' : ''}" style="flex:1">${t('dict.kind.word')}</button>
          <button data-kind="pattern" class="${e.kind === 'pattern' ? 'on' : ''}" style="flex:1">${t('dict.kind.pattern')}</button>
        </div>
        <div class="group-head">${t('dict.surface')}</div>
        <div class="group"><div class="row"><input id="de-surface" class="grow" style="background:none"
          value="${escAttr(e.surface)}" placeholder="${escAttr(e.kind === 'pattern' ? t('dict.surfacePhPattern') : t('dict.surfacePhWord'))}"></div></div>
        <div class="group-head">${t('dict.reading')}</div>
        <div class="group"><div class="row"><input id="de-reading" class="grow" style="background:none"
          value="${escAttr(e.reading)}" placeholder="${escAttr(e.kind === 'pattern' ? t('dict.readingPhPattern') : t('dict.readingPhWord'))}"></div></div>
        <div class="group"><div class="row">
          <span class="grow" id="de-layer-label">${t('dict.layerN', { n: e.layer })}</span>
          <span class="stepper"><button id="de-layer-dec">−</button><span class="sep"></span><button id="de-layer-inc">＋</button></span>
        </div></div>
        <div class="desc" style="padding:0 4px 16px">${t('dict.layerDesc')}</div>
        <div class="group">
          <div class="row"><span class="grow">${t('dict.pads')}</span>${sw('de-pads', e.padsBoundary)}</div>
          <div class="row"><span class="grow">${t('dict.enabled')}</span>${sw('de-enabled', e.enabled)}</div>
        </div>
        <div class="desc" style="padding:0 4px 16px">${t('dict.padsDesc')}</div>
        <div class="group"><button class="row danger" id="de-del"
          style="width:100%;text-align:start;color:#ff453a">${t('dict.remove')}</button></div>
      </div>`;

    const back = async () => { await commit(); renderList(); };
    $('#de-back').addEventListener('click', back);
    for (const b of modal.querySelectorAll('#de-kind button')) {
      b.addEventListener('click', () => { e.kind = b.dataset.kind; renderEntry(i); });
    }
    $('#de-surface').addEventListener('input', (ev) => {
      e.surface = ev.target.value;
      // 不正な正規表現は「その行は無視される」ので、その場で警告する
      ev.target.style.color = (e.kind === 'pattern' && !isValidPattern(e.surface)) ? '#ff9500' : '';
      ev.target.title = (e.kind === 'pattern' && !isValidPattern(e.surface)) ? t('dict.badPattern') : '';
    });
    $('#de-reading').addEventListener('input', (ev) => { e.reading = ev.target.value; });
    const setLayer = (d) => {
      e.layer = Math.min(10, Math.max(1, e.layer + d));
      $('#de-layer-label').textContent = t('dict.layerN', { n: e.layer });
    };
    $('#de-layer-dec').addEventListener('click', () => setLayer(-1));
    $('#de-layer-inc').addEventListener('click', () => setLayer(+1));
    $('#de-pads').addEventListener('change', (ev) => { e.padsBoundary = ev.target.checked; });
    $('#de-enabled').addEventListener('change', (ev) => { e.enabled = ev.target.checked; });
    $('#de-del').addEventListener('click', async () => { entries.splice(i, 1); await commit(); renderList(); });
    $('#de-surface').focus();
  }

  // 本文の右クリックから来たときは、その語の編集画面をいきなり開く。
  renderList();
  if (addSurface) {
    entries.unshift({ surface: addSurface, reading: '', layer: 6, kind: 'word', padsBoundary: false, enabled: true });
    renderEntry(0);
  }
}

/**
 * 数値をひとつ入力させる小さなモーダル(自動ページ送りの間隔・スリープタイマーの分)。
 * プリセットはメニューに並べてあるので、ここは「それ以外の値」のためだけに使う。
 *
 * リーダーと書棚の両方から使う——スリープタイマーはどちらの画面からも掛けられる。
 */
export function promptNumber({ title, label, value, min, max, presets = [] }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop show';
    back.innerHTML = `<div class="modal">
      <h2>${escapeText(title)}</h2>
      <div class="row"><label>${escapeText(label)}</label>
        <input id="num-input" class="grow" type="number" min="${min}" max="${max}" value="${value}"></div>
      <div class="row" style="flex-wrap:wrap;gap:6px">
        ${presets.map((p) => `<button class="num-preset" data-v="${p}">${p}</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button id="num-cancel">${escapeText(t('common.cancel'))}</button>
        <button id="num-ok" class="primary">${escapeText(t('common.ok'))}</button>
      </div></div>`;
    document.body.appendChild(back);
    const input = back.querySelector('#num-input');
    input.focus();
    input.select();
    const done = (v) => { back.remove(); resolve(v); };
    const ok = () => {
      const n = Math.round(parseFloat(input.value));
      done(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null);
    };
    for (const b of back.querySelectorAll('.num-preset')) {
      b.addEventListener('click', () => done(Number(b.dataset.v)));
    }
    back.querySelector('#num-cancel').addEventListener('click', () => done(null));
    back.querySelector('#num-ok').addEventListener('click', ok);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') done(null); });
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
  });
}

function escapeText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function escAttr(s) { return String(s).replace(/"/g, '&quot;'); }

#!/usr/bin/env node
// EPUB リーダーのテストバス ブリッジ 兼 MCP サーバ(依存ゼロ・Node 組込みのみ)。
//
// 役割:
//  - HTTP(127.0.0.1:47832) を立て、アプリのフロント(app/testbus.js)が /pull でコマンドを取りに来る。
//  - 操作側は 2 経路: (a) `POST /cmd {cmd,args}` を curl 等で直接、(b) MCP stdio ツール。
//    どちらも同じジョブキューに積まれ、アプリで実行 → /result で結果が返る。
//  - これにより computer-use なしでアプリを外部から駆動・観測できる。
//
// 注: MCP stdio は JSONL(改行区切りJSON)。Content-Length ヘッダは付けない。
//     ログは必ず stderr へ(stdout は MCP 専用)。

import http from 'node:http';

const PORT = 47832;
const HOST = '127.0.0.1';

let counter = 0;
const jobs = [];            // 未配信ジョブ {id, cmd, args}
const pullWaiters = [];     // /pull で待機中の res
const pending = new Map();  // id -> {resolve, timer}
let lastPullAt = 0;

const log = (...a) => process.stderr.write('[testbus] ' + a.join(' ') + '\n');

// クロスオリジン(webview の origin → 127.0.0.1:47832)なので全応答に CORS が必須。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function deliverIfPossible() {
  // Tauri アプリ(kind=app)のプラーにのみ配信する。
  // ブラウザプレビュー等(kind!=app)が同じブリッジを叩いてもコマンドを横取りさせない。
  while (jobs.length) {
    const idx = pullWaiters.findIndex((w) => w.kind === 'app');
    if (idx < 0) break;
    const job = jobs.shift();
    const [w] = pullWaiters.splice(idx, 1);
    clearTimeout(w.timer);
    w.res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    w.res.end(JSON.stringify(job));
  }
}

// ホスト/クライアントの2モード:
//  - ホスト: 自分で HTTP を持ちアプリの /pull を捌く。
//  - クライアント: ポートが既に使われている(別のブリッジが稼働)場合、そこへ /cmd を転送する。
// これで standalone(curl用) と MCP 起動の 2 プロセスが同時にいても競合しない。
let hostMode = true;

// コマンドを積んで結果を待つ。アプリ未接続なら timeout。
function runCommand(cmd, args, timeoutMs = 30000) {
  if (!hostMode) {
    // クライアントモード: 既存ブリッジへ転送
    return fetch(`http://${HOST}:${PORT}/cmd`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, args: args || {}, timeoutMs }),
    }).then((r) => r.json()).then((j) => { if (!j.ok) throw new Error(j.error); return j.value; });
  }
  return new Promise((resolve, reject) => {
    const id = ++counter;
    jobs.push({ id, cmd, args: args || {} });
    const timer = setTimeout(() => {
      pending.delete(id);
      const idx = jobs.findIndex((j) => j.id === id);
      if (idx >= 0) jobs.splice(idx, 1);
      reject(new Error('timeout: アプリが接続/応答していない可能性があります (cmd=' + cmd + ')'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    deliverIfPossible();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  // アプリ → 次のジョブを取りに来る(ロングポール)。?kind=app のみジョブを受け取れる。
  if (req.method === 'GET' && req.url.startsWith('/pull')) {
    const kind = new URL(req.url, `http://${HOST}`).searchParams.get('kind') || '';
    if (kind === 'app') lastPullAt = Date.now();
    if (kind === 'app' && jobs.length) {
      const job = jobs.shift();
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(job));
    }
    const waiter = { res, timer: null, kind };
    waiter.timer = setTimeout(() => {
      const i = pullWaiters.indexOf(waiter);
      if (i >= 0) pullWaiters.splice(i, 1);
      res.writeHead(204, cors); res.end();
    }, 25000);
    pullWaiters.push(waiter);
    return;
  }

  // アプリ → 実行結果
  if (req.method === 'POST' && req.url === '/result') {
    const body = await readBody(req);
    try {
      const r = JSON.parse(body);
      const p = pending.get(r.id);
      if (p) {
        pending.delete(r.id);
        clearTimeout(p.timer);
        if (r.ok) p.resolve(r.value);
        else p.reject(new Error(r.error || 'error'));
      }
    } catch (e) { log('result parse error', e.message); }
    res.writeHead(200, cors); return res.end('ok');
  }

  // 操作側 → コマンド投入(curl 等から直接テスト可能)
  if (req.method === 'POST' && req.url === '/cmd') {
    const body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, cors); return res.end('bad json'); }
    try {
      const value = await runCommand(payload.cmd, payload.args, payload.timeoutMs);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value }));
    } catch (e) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    const appWaiting = pullWaiters.some((w) => w.kind === 'app');
    return res.end(JSON.stringify({ ok: true, appConnected: appWaiting || (Date.now() - lastPullAt < 5000), queued: jobs.length }));
  }

  res.writeHead(404, cors); res.end('not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    hostMode = false;
    log(`port ${PORT} 使用中 → クライアントモード(既存ブリッジへ転送)`);
  } else {
    log('http error', e.message);
  }
});
server.listen(PORT, HOST, () => log(`bridge on http://${HOST}:${PORT} (/cmd /pull /result /health)`));

// ---------------- MCP stdio ----------------

const TOOLS = [
  { name: 'tb_cmd', description: '任意のテストバスコマンドを実行。cmd と args を指定。利用可能な cmd: ping, state, library, open, import, remove, resetLibrary(本棚), page, gotoFraction, gotoHref, toc, currentText, highlightedText, ttsPlay, ttsPause, ttsResume, ttsStop, ttsState, eval, navigate(共通)。',
    inputSchema: { type: 'object', properties: { cmd: { type: 'string' }, args: { type: 'object' } }, required: ['cmd'] } },
  { name: 'tb_state', description: 'いま表示中のページ状態(本棚 or リーダー)を返す。リーダーなら bookId/章index/進捗/読み上げ状態など。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tb_library', description: '本棚の一覧(id/title/author/yomi/五十音section)を返す。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tb_import', description: '指定パスの EPUB を取り込む(本棚画面で実行)。', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'tb_open', description: 'id の本をリーダーで開く(本棚画面で実行)。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'tb_page', description: 'ページ送り。dir: left|right|prev|next。', inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] } },
  { name: 'tb_goto_fraction', description: '進捗(0..1)へシーク。', inputSchema: { type: 'object', properties: { fraction: { type: 'number' } }, required: ['fraction'] } },
  { name: 'tb_toc', description: '目次(ラベル/href/深さ)を返す。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tb_current_text', description: '現在セクションの可視テキスト先頭 max 文字を返す(既定400)。', inputSchema: { type: 'object', properties: { max: { type: 'number' } } } },
  { name: 'tb_tts_play', description: '読み上げ開始。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tb_tts_stop', description: '読み上げ停止。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tb_highlighted_text', description: '読み上げ中にハイライトされている現在文のテキストを返す。', inputSchema: { type: 'object', properties: {} } },
  { name: 'tb_eval', description: 'アプリ内で任意 JS を実行し結果を返す(デバッグ・アサーション用)。', inputSchema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
  { name: 'tb_screenshot', description: 'アプリウィンドウの描画をスクリーンショット(PNG)で返す。実際のレンダリング/レイアウトを目視確認する用。', inputSchema: { type: 'object', properties: {} } },
];

const TOOL_TO_CMD = {
  tb_state: (a) => ['state', a],
  tb_library: (a) => ['library', a],
  tb_import: (a) => ['import', a],
  tb_open: (a) => ['open', a],
  tb_page: (a) => ['page', a],
  tb_goto_fraction: (a) => ['gotoFraction', a],
  tb_toc: (a) => ['toc', a],
  tb_current_text: (a) => ['currentText', a],
  tb_tts_play: (a) => ['ttsPlay', a],
  tb_tts_stop: (a) => ['ttsStop', a],
  tb_highlighted_text: (a) => ['highlightedText', a],
  tb_eval: (a) => ['eval', a],
  tb_screenshot: (a) => ['screenshot', a],
  tb_cmd: (a) => [a.cmd, a.args || {}],
};

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handleRpc(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'epub-reader-testbus', version: '0.1.0' } } });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // 通知は応答なし
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const map = TOOL_TO_CMD[name];
    if (!map) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool: ' + name } });
    const [cmd, cmdArgs] = map(args);
    try {
      const value = await runCommand(cmd, cmdArgs);
      // スクショは画像コンテンツで返す(Claude が直接見られる)
      if (name === 'tb_screenshot' && value?.b64) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: value.b64, mimeType: value.mime || 'image/png' }] } });
      } else {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: ' + String(e.message || e) }], isError: true } });
    }
    return;
  }
  if (typeof id !== 'undefined') send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handleRpc(msg).catch((e) => log('rpc error', e.message));
  }
});
process.stdin.on('end', () => { /* stdin 終了でも HTTP は継続 */ });

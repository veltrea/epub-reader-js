// アプリ内テストバス。computer-use に頼らずアプリを外部から駆動・観測するための仕組み。
// 仕組み: フロントが localhost のブリッジ(mcp/testbus-mcp/server.mjs)を HTTP ロングポーリングし、
//   受け取ったコマンドを実行して結果を返す。ブリッジは curl(`POST /cmd`)からも MCP からも叩ける。
//
// **配布版では動かさない**。届いた命令はアプリの権限で走るので、常時つないでおくと
// 「そのポートを先に掴んだローカルのプロセス」に画面キャプチャや任意パスへの書き出しを
// させられてしまう。可否はバックエンド(`testbus_enabled`)が決める——デバッグビルド、
// または `EPUB_READER_TESTBUS=1` を付けて起動したときだけ有効。
// ブラウザプレビューでは既定で動かさない(同じブリッジからコマンドを横取りしないように)。
// どうしても非 Tauri で使う場合のみ localStorage.testbus='on'。
import { IS_TAURI, captureWindow, listWindows, testbusEnabled } from './api.js';
const BASE = 'http://127.0.0.1:47832';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const handlers = Object.create(null);

/** ページ固有のコマンド実行関数を登録。{ cmd: async (args)=>value } */
export function registerTestbus(map) {
  Object.assign(handlers, map);
}

// 汎用ビルトイン
registerTestbus({
  ping: async () => ({ ok: true, page: location.pathname, href: location.href }),
  loc: async () => ({ pathname: location.pathname, search: location.search }),
  navigate: async ({ url }) => { location.href = url; return { navigating: url }; },
  eval: async ({ js }) => {
    // 任意JS実行(デバッグ・アサーション用)。戻り値は JSON 化される。
    // 注: 配布版は CSP(script-src 'self')で new Function が禁止のため使えない。型付きコマンドを推奨。
    const fn = new Function('return (async()=>{ ' + js + ' })()');
    return await fn();
  },
  // 要素をひとつ押す。モーダルは書棚にもリーダーにも出るので、ページ固有ではなくここに置く。
  click: async ({ sel }) => {
    const el = document.querySelector(sel);
    if (!el) return { clicked: false };
    el.click();
    return { clicked: true };
  },
  // 入力欄に文字を入れる。**実際のキー入力の代わり**。
  //
  // click は要素の click() を呼ぶだけなので、入力欄に文字を打つ焦点は移らない。
  // そのため今まではマウスを実際に動かして押し、クリップボードから貼り付けていた。
  // 押す場所を窓の中の割合で決めていたので、画面の中身が少し変わるだけで外れた
  // （マニュアルの写真を撮り直すときに実際に外れた）。
  //
  // 値を入れたあと input と change を出す。画面側はどちらかを聞いているので、
  // 人が打ったときと同じように動く。
  setValue: async ({ sel, value }) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: '要素が見つからない: ' + sel };
    el.value = String(value ?? '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, sel, value: el.value };
  },
  // 要素の HTML をそのまま返す。画面に届いた形を、加工せずに目で見るため。
  // 「指定が効かない」とき、指定そのものが書かれていないのか、書いてあるのに
  // 無視されているのかを、これで分けられる。
  outerHTML: async ({ sel, limit = 3 }) => {
    return [...document.querySelectorAll(sel)].slice(0, limit).map((el) => el.outerHTML.slice(0, 600));
  },
  // 画面に効いている安全のための決まり(CSP)を、そのまま返す。
  csp: async () => {
    const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return { meta: m ? m.getAttribute('content') : null };
  },
  // 要素の見た目を、JavaScript から直に設定して、効くかどうかを見る。
  // 「HTML に書いた指定が効かない」とき、書き方の問題なのか、画面全体で
  // 見た目の指定が止められているのかを、これで分けられる。
  setStyle: async ({ sel, prop, value }) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: '要素が見つからない: ' + sel };
    const before = getComputedStyle(el).getPropertyValue(prop);
    el.style.setProperty(prop, value);
    return { ok: true, before, after: getComputedStyle(el).getPropertyValue(prop), attr: el.getAttribute('style') };
  },
  // 要素の状態を外から読む。クラスの付け外しは撮った絵からは判定できない
  // (「付いているのに描かれない」のか「そもそも付いていない」のかを分ける)。
  domInfo: async ({ sel, limit = 12 }) => {
    return [...document.querySelectorAll(sel)].slice(0, limit).map((el) => {
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: el.className,
        text: (el.textContent || '').trim().slice(0, 40),
        hidden: !!el.hidden,
        bg: cs.backgroundColor,
        color: cs.color,
        display: cs.display,
      };
    });
  },
  // ウィンドウ描画のスクリーンショット(PNG base64)。ピクセルを見ないと分からない検証用。
  screenshot: async () => ({ mime: 'image/png', b64: await captureWindow() }),
  // xcap から見えているウィンドウの一覧。screenshot が「見つかりません」と言うとき、
  // 何が見えているのかを確かめる。
  windows: async () => await listWindows(),
});

async function exec(cmd, args) {
  const fn = handlers[cmd];
  if (!fn) throw new Error('unknown cmd: ' + cmd);
  const v = await fn(args || {});
  // JSON 化できる形に(循環等は文字列化)
  try { JSON.stringify(v); return v; } catch { return String(v); }
}

/**
 * 例外を読める文字列にする。
 * **WebKit の `Error.stack` にはメッセージが入っていない**（V8 は入る）ので、
 * stack だけを返すと「位置は分かるが何が起きたのか分からない」報告になる。
 * 名前とメッセージを必ず先頭に置く。
 */
function errorText(e) {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name || 'Error'}: ${e.message || '(no message)'}`;
  return e.stack ? `${head}\n${e.stack}` : head;
}

async function handleJob(job) {
  // 各ジョブは非ブロッキングで処理する。重いハンドラ(読み上げ等)が pull ループを
  // 止めないように、exec は await せずここで独立に走らせて結果を返す。
  let res;
  try { res = { id: job.id, ok: true, value: await exec(job.cmd, job.args) }; }
  catch (e) { res = { id: job.id, ok: false, error: errorText(e) }; }
  try {
    await fetch(BASE + '/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res),
    });
  } catch { /* ブリッジが消えた→破棄 */ }
}

let running = false;
async function loop() {
  while (running) {
    let job = null;
    try {
      const r = await fetch(BASE + '/pull?kind=app', { method: 'GET' });
      if (r.status === 204) continue; // コマンドなし(タイムアウト)→即再ポール
      if (!r.ok) { await sleep(1500); continue; }
      job = await r.json();
    } catch {
      await sleep(2000); // ブリッジ未起動→静かにリトライ
      continue;
    }
    if (!job || !job.cmd) continue;
    handleJob(job); // await しない→次の pull をすぐ継続(重いコマンドで固まらない)
  }
}

export async function startTestbus() {
  const forced = typeof localStorage !== 'undefined' && localStorage.getItem('testbus') === 'on';
  if (!IS_TAURI && !forced) return; // ブラウザプレビューでは動かさない
  if (typeof localStorage !== 'undefined' && localStorage.getItem('testbus') === 'off') return;
  // 配布ビルドでは有効化されない(上のコメント参照)。localStorage では上書きできない。
  //
  // 問い合わせに**失敗した**ときだけ試し直す。ページを読み込み直した直後は、
  // バックエンドへの経路がまだ整っておらず、1 回目が例外になることがある。そこで
  // 諦めると、そのページではテストバスが起動せず、外から一切さわれなくなる
  // (実際に navigate を繰り返すと再現した)。false が返ったときは無効という答えなので、
  // 試し直さずそのまま終わる。
  if (IS_TAURI) {
    let allowed = false;
    // **回数で諦めない。** 以前は約 3 秒ぶん試して打ち切っていたが、それだと
    // 読み込み直した直後に経路が整うのが少し遅れただけで、そのページでは
    // テストバスが二度と起動しなくなる(実際に起きた)。失敗は「まだ答えられない」
    // という意味しか持たないので、答えが返るまで試し直す。
    // 待つ間隔は 200ms から少しずつ伸ばし、2 秒で頭打ちにする。
    for (let i = 0; ; i++) {
      try { allowed = await testbusEnabled(); break; } catch {
        await sleep(Math.min(2000, 200 + i * 200));
      }
    }
    if (!allowed) return;   // false は「無効」という答え。試し直さない。
  }
  if (running) return;
  running = true;
  loop();
}

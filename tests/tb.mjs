// テストバス クライアント(Node)。ブリッジ(mcp/testbus-mcp/server.mjs)経由でアプリを駆動する。
// computer-use 不要。使う前にブリッジ起動 + アプリ起動が必要。
const BASE = process.env.TB_BASE || 'http://127.0.0.1:47832';

export async function health() {
  const r = await fetch(BASE + '/health');
  return r.json();
}

/** コマンドを1つ実行して value を返す。失敗時は例外。 */
export async function tb(cmd, args = {}) {
  const r = await fetch(BASE + '/cmd', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, args }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`tb(${cmd}) failed: ${j.error}`);
  return j.value;
}

/** アプリ接続を待つ。 */
export async function waitApp(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await health()).appConnected) return true; } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('app not connected (ブリッジ/アプリが起動しているか確認)');
}

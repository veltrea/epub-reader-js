// アプリのスクリーンショットを取得して PNG 保存する(computer-use 非依存)。
// 実行: node tests/shot.mjs [出力パス]
import { tb, waitApp } from './tb.mjs';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || '/tmp/epub-reader-shot.png';
await waitApp();
const r = await tb('screenshot');
if (!r?.b64) { console.error('no image'); process.exit(1); }
writeFileSync(out, Buffer.from(r.b64, 'base64'));
console.log('saved', out, Math.round(r.b64.length / 1024) + 'KB(b64)');

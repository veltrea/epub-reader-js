// 設定と版番号の食い違いを機械で見つける。
//
// どれも「正解が一意に決まる」ものだけを見る。人の判断が要るものはここに入れない。
//
// 実行: node scripts/check-config.mjs

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const errors = [];
const warnings = [];
const ok = (msg) => console.log(`  ok   ${msg}`);

// ---- 1. 版番号が 2 か所で一致しているか -------------------------------------
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (conf.version !== cargoVersion) {
  errors.push(`版番号が食い違っています: tauri.conf.json=${conf.version} / Cargo.toml=${cargoVersion}`);
} else ok(`版番号 ${conf.version}`);

// ---- 2. ビルド番号 -----------------------------------------------------------
// 「同じ版の成果物を二度出す」事故を防ぐための連番。焼き先は Info.plist の CFBundleVersion。
if (!existsSync('src-tauri/build-number')) {
  errors.push('src-tauri/build-number がありません (scripts/bump-build.sh が作ります)');
} else {
  const n = readFileSync('src-tauri/build-number', 'utf8').trim();
  if (!/^\d+$/.test(n)) errors.push(`build-number が数値ではありません: ${JSON.stringify(n)}`);
  else {
    const plist = readFileSync('src-tauri/Info.plist', 'utf8');
    const inPlist = plist.match(/<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/)?.[1];
    if (inPlist !== n) {
      errors.push(`Info.plist の CFBundleVersion(${inPlist}) が build-number(${n}) と違います — scripts/bump-build.sh を通してください`);
    } else ok(`ビルド番号 ${n} (${conf.version}+${n})`);
  }
}

// ---- 3. CSP -----------------------------------------------------------------
// HTML の <meta> だけだと Tauri が出すエラーページや後から足す窓に効かない。
const csp = conf.app?.security?.csp;
if (!csp || typeof csp !== 'string') {
  errors.push('tauri.conf.json の app.security.csp が空です (meta だけではエラーページに効きません)');
} else if (/'unsafe-eval'|script-src[^;]*\*/.test(csp)) {
  errors.push(`CSP が緩すぎます: ${csp.slice(0, 80)}…`);
} else ok('CSP が conf 側にある');

// ---- 4. 漏らしたくないものが追跡されていないか -------------------------------
const gitignore = readFileSync('.gitignore', 'utf8');
for (const must of ['.claude/', 'target/', 'node_modules/']) {
  if (!gitignore.split('\n').some((l) => l.trim() === must)) {
    errors.push(`.gitignore に ${must} がありません`);
  }
}
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n');
const leaked = tracked.filter((f) => /(^|\/)\.claude\/|settings\.local\.json$|\.env$/.test(f));
if (leaked.length) errors.push(`追跡してはいけないファイルが入っています: ${leaked.join(', ')}`);
else ok('秘匿しておきたいパスは追跡されていない');

// ---- 4b. テキストのはずのファイルに NUL が混ざっていないか --------------------
// 一度これで詰まった: 区切り文字を エスケープ と書くつもりで**生の 0x00 バイト**を
// 埋めてしまい、`file` がバイナリ判定 → **`grep` が既定でヒットを出さなくなった**。
// git では普通に扱えるので気づきにくく、探し物をしているときに黙って空振りする。
const textLike = /\.(js|mjs|cjs|ts|json|md|html|css|rs|toml|yml|yaml|sh|py)$/;
const withNul = tracked
  .filter((f) => f && textLike.test(f) && existsSync(f))
  .filter((f) => readFileSync(f).includes(0));
if (withNul.length) {
  errors.push(`NUL バイトを含むテキストファイル（grep が黙ります。'\\u0000' と書いてください）: ${withNul.join(', ')}`);
} else ok('テキストファイルに NUL は無い');

// ---- 5. マニュアルの取りこぼし(警告のみ) -------------------------------------
// メニューに項目を足したのにマニュアルに一言も無い、を拾う。文言は人が書くので警告どまり。
const ja = JSON.parse(readFileSync('src/locales/ja.json', 'utf8'));
const manual = readFileSync('MANUAL.ja.md', 'utf8');
const undocumented = Object.entries(ja)
  .filter(([k]) => /^menu\.(file|view|go|tts)\./.test(k))
  .filter(([, v]) => typeof v === 'string' && v.length >= 4 && !v.includes('{'))
  .map(([k, v]) => [k, v.replace(/[…\s]/g, '')])
  .filter(([, v]) => !manual.replace(/[…\s]/g, '').includes(v));
if (undocumented.length) {
  warnings.push(`MANUAL.ja.md に出てこないメニュー項目が ${undocumented.length} 件: `
    + undocumented.map(([k, v]) => `${v}(${k})`).join(' / '));
}

// ---- 結果 -------------------------------------------------------------------
for (const w of warnings) console.warn(`warn: ${w}`);
if (errors.length) {
  console.error(`\n設定に問題があります (${errors.length} 件):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`ok — 設定の検査を通過 (warn ${warnings.length})`);

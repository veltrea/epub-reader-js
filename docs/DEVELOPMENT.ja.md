# 開発メモ

English: [DEVELOPMENT.md](DEVELOPMENT.md)

## 構成

```
src/                     フロント — 素の ESM。バンドラ無し。Tauri の frontendDist としてそのまま配信
  index.html  app/shelf.js     書棚
  reader.html app/reader.js    リーダー
  app/tts.js                   読み上げ制御(foliate の文分割・ハイライトを再利用し、音声だけ差し替え)
  app/dictionary.js kana.js    読み上げ辞書・かな処理(純粋。Node でテストできる)
  app/sleeptimer.js autopager.js timers.js   タイマー(純粋なロジック + 画面をまたぐ共有インスタンス)
  app/api.js                   Tauri コマンドの薄いラッパー(ブラウザでは no-op に落ちる)
  app/menu.js                  ネイティブメニューの橋渡し
  app/store.js ui-modals.js i18n.js  永続化・モーダル・翻訳
  locales/*.json               UI 文字列の唯一の出所。Rust 側も同じファイルを読む
  foliate-js/                  vendored の表示エンジン(改変あり。THIRD_PARTY_LICENSES.ja.md 参照)

src-tauri/               Rust — 薄い I/O 層
  src/lib.rs                   JSON ストア・本の取り込み・ファイル読み・TTS/LLM のプロキシ
  src/menu.rs                  ネイティブメニュー。文言は src/locales/*.json を include_str! で共有

tests/                   ロジックテスト・テストバスのクライアント・E2E スモーク
mcp/testbus-mcp/         テストバスのブリッジ(MCP サーバーも兼ねる)
```

**設計の原則**: 組版・表示・読み上げ制御はフロントの担当。Rust は永続化と HTTP プロキシに
徹する（TTS エンジンは CORS を避けるため Rust 経由で呼ぶ）。純粋にできるロジックは
DOM 非依存に切り出し、Node でテストする。

## Content Security Policy

CSP は**意図的に2箇所に、同じ内容で**置いてあります。`src/index.html` と
`src/reader.html` の `<meta>`、そして `src-tauri/tauri.conf.json` の
`app.security.csp` です。meta はページを、conf は Tauri 自身が描くもの（エラーページ、
今後足す窓）を守ります。**片方を変えたらもう片方も変えること。**

`script-src 'self'` なので `new Function` と `eval` は動きません。これは意図したもので、
デバッグの近道のために緩めないでください。

## テスト

```bash
node tests/logic.test.mjs          # DOM 非依存のロジック(かな・辞書・タイマー…)
cd src-tauri && cargo test --lib   # Rust のユニット(メニュー訳文・パス処理・対応拡張子)
```

どちらも画面も本も TTS エンジンも要りません。

## テストバス

アプリを外から駆動・観測する仕組みです。スクリーンショットや合成クリックには頼りません。
フロントがローカルのブリッジを長ポーリングし、届いたコマンドを実行して結果を返します。

- `src/app/testbus.js` — アプリ側
- `mcp/testbus-mcp/server.mjs` — ブリッジ兼 MCP サーバー（Node・依存ゼロ）。`POST /cmd` と
  MCP stdio の両方を提供。ポートが埋まっていればクライアントモードに切り替えて既存の
  ブリッジへ転送するので、standalone と MCP 起動が競合しません
- `tests/tb.mjs` — 小さな Node クライアント
- `tests/smoke.mjs` — E2E スモークテスト
- `tests/shot.mjs` — アプリの実描画を PNG で保存

**テストバスは配布ビルドでは動きません。** コマンドはアプリの権限で走るので、配布版で
ポートを開けたままにすると、先にそのポートを掴んだローカルのプロセスがリーダー越しに
画面を撮ったりファイルを書いたりできてしまいます。有効になるのはデバッグビルドか、
`EPUB_READER_TESTBUS=1` を付けて起動したときだけです:

```bash
node mcp/testbus-mcp/server.mjs &                       # ブリッジ
EPUB_READER_TESTBUS=1 ./src-tauri/target/release/epub-reader &
curl -s -XPOST http://127.0.0.1:47832/cmd \
  -H 'Content-Type: application/json' -d '{"cmd":"state"}'
node tests/smoke.mjs
```

`capture_window`（スクリーンショット）も同じ条件で塞いであります。macOS が初回に
「画面収録」の許可を求めることがあります。

主なコマンド: `ping` `state` `library` `open` `import` `remove` `setSort` `setFilter`
`visible` `collections` `profiles` `sleepTimerStart/Cancel/State`（書棚）/ `page`
`gotoFraction` `gotoHref` `toc` `currentText` `highlightedText` `progressDir`
`getSettings` `setSetting` `computedFont` `rubyInfo` `imagePageInfo`
`ttsPlay/Pause/Resume/Stop/State` `autoPagerStart/Stop`（リーダー）/ `screenshot`
`navigate`（共通）。

**MCP から使う**: `.mcp.json` に `epub-reader-testbus` を登録済み。`tb_state` /
`tb_page` / `tb_toc` / `tb_current_text` / `tb_tts_play` / `tb_screenshot` などが使えます。

## メニュー項目を足すとき

ネイティブメニューは `src-tauri/src/menu.rs` で組み立て、クリックはフロントへ転送されて
`shelf.js` / `reader.js` の `setupMenu(...)` に渡したハンドラ表で振り分けられます。

項目を足したら、**両方のハンドラ表を確認してください。** `menu.rs` で `enabled: true`
なのにハンドラが無い項目は「押せるのに何も起きない」死んだ項目になります。探し方:

```bash
# menu.rs が出す id
grep -oE '(item|check|raw_check)\("[a-z][^"]*"' src-tauri/src/menu.rs | sed 's/.*("//;s/"//' | sort -u
# 各画面のハンドラ表
sed -n "/await setupMenu('reader'/,/}, settings.lang/p" src/app/reader.js | grep -oE "'[a-z][a-zA-Z.]*'"
sed -n "/await setupMenu('shelf'/,/}, settings.lang/p"  src/app/shelf.js  | grep -oE "'[a-z][a-zA-Z.]*'"
```

片方の画面でしか意味がない項目は、`enabled` に `reader` / `shelf` のフラグを渡して
淡色にします（黙って無反応にしない）。

## 翻訳

`src/locales/ja.json` と `en.json` は平坦なキー→文字列の対応表で、**同じキー集合**を
持っていなければなりません（メニューのキーが片方に無いと `cargo test --lib` が落ちます）。
画面に出る文字列を JS に直書きしないこと。必ずキーを足してください。

## 配布物を作る

```bash
./scripts/package-macos.sh
```

ビルド → ad-hoc 再署名（Tauri がビルド時に付ける署名はリソースが未封印で
`codesign --verify` に落ちる）→ dmg と zip を作成 → 受け取る人と同じ展開の仕方で検証、
までを通します。中のコメントを読んでから触ってください。各手順は、macOS で配布物が
壊れる具体的な経路それぞれへの対処です。

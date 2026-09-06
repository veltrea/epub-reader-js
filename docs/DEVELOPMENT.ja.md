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
  app/api.js                   Tauri コマンドの薄い包み(ブラウザでは何もしない)
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

## 検査（`./scripts/check.sh`）

```bash
./scripts/check.sh
```

7 つの検査をまとめて回します。CI からも同じものを回します。
**それぞれが何を見ていて、止まったとき何をすればよいかは [CHECKS.ja.md](CHECKS.ja.md) に
1 つずつ書いてあります。** ここに入れてよいのは
**人に聞かなくても正解が一意に決まるもの**だけです。判断が要るもの（設計の是非・
何を公開するか）は入れません——警告が出るたびに人を止めることになり、結局その警告が
読まれなくなります。

### 機能を足したとき、どの検査が何を要求するか

**検査は「間違いを責めるもの」ではなく「次にやることを教えるもの」です。** 止まったら、
その場で言われたとおりに直せば済みます。下は、何を足すとどれが反応するかの一覧です。

| 足したもの | 反応する検査 | 何をすればよいか |
|---|---|---|
| メニュー項目 | メニューの配線 | `reader.js` / `shelf.js` のハンドラ表に処理を書く。片方の画面だけで意味がある項目は、`menu.rs` の `enabled` に `reader` / `shelf` を渡して淡色にする |
| 画面に出る文字 | 画面に出る文字列の直書き | `src/locales/ja.json` と `en.json` の**両方**にキーを足して、`t('キー')` で呼ぶ |
| メニュー項目・設定・テストバスの命令 | 機能の記録 | 増えた分をマニュアルに書く。書いたら `node scripts/feature-inventory.mjs --write` で記録を更新する |
| 機能のまとまり | 記号の突き合わせ | マニュアルの説明に `<!-- menu:xxx -->` の形の印を付ける。印の無い機能があると止まる |
| 文書に画面の文字を引用 | 文書の画面の文字 | 引用した文字を `ja.json` にあるものと同じにする。画面の側が正しくないなら、そちらを先に直す |
| ロジック（純粋な関数） | ロジックのユニットテスト | `tests/logic.test.mjs` にテストを足す。画面を作らずに試せる形（DOM を触らない関数）にしておくと書ける |
| 版番号・配布の設定 | 設定・版番号・秘匿パス | 2 か所ある版番号をそろえる。秘匿しておきたいパスを追跡させない |

### 検査が邪魔になったとき

**まず「検査が間違っているのか、実装が間違っているのか」を決めます。** 実装の方が
新しいなら、実装が正です（文書や記録の側を直します）。

検査の網から外したいものが出たときは、**除外の一覧に足して、理由をその場に書きます**。
理由の無い除外は、次に読む人が消せません。

検査そのものが役に立たなくなったら消してよいです。ただし**消した理由をコミットに書く**
こと。「うるさいから」は理由になりません——うるさいのは、網が広すぎるか、実装が
実際に食い違っているかのどちらかです。

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
`ttsHighlightInfo` `ttsHighlightRects`（読み上げの帯の範囲と矩形。ルビのある行で帯が
太くなっていないかを数値で見る）
`dictList` `dictAdd` `dictUpdate` `dictDelete` `dictGet` `dictSet` `setRules`（読み上げ辞書。
`scope` に `common`＝すべての本（既定）/ `book`＝この本だけ / `merged`＝読み上げに渡すのと
同じ並び、を指定する）
`openDictForm` `openDictList` `dictOpenEntry` `dictSetScope` `dictBack` `dictDone` `dictClose`
（辞書の**画面**を人と同じ順に操作する。データだけ書き換えるのではなく、画面が実際に
動くことを確かめるために使う。**登録する画面と一覧の画面は別なので、開く命令も二つある。**
`openDictForm` が登録する画面、`openDictList` が一覧。`dictOpenEntry` は一覧の行を開き、
`dictSetScope` は適用範囲を反対側へ移し、`dictBack` は一覧へ移り、`dictDone` は登録の画面を
保存して閉じ、`dictClose` は一覧を閉じる。どちらも書棚の画面にもある。
`openDictForm` の `place` に `{section, offset}` を渡すと「この場所だけの読みを登録」と
同じ画面になる。**画面を閉じる命令は保存が終わるまで待って返る**——待たずに次の書き換えを
送ると、遅れて動いた保存が古い中身で上書きしてしまう）
`applyRules` `dictPrepare` にも `place` を渡せる（「この場所だけ」の登録が当たるかを、
読み上げずに確かめられる）。`ttsHighlightInfo` の `place` は、いま読み上げている文が
本のどこにあるかを返す（登録した場所と照らし合わせるために使う）。
`ttsPlay/Pause/Resume/Stop/State` `autoPagerStart/Stop`（リーダー）/ `screenshot`
`navigate` `click` `domInfo` `setValue`（共通）。

`setValue` は入力欄に文字を入れて `input` と `change` を出します。`click` は要素の
`click()` を呼ぶだけで入力の焦点は移らないので、外から文字を打つにはこちらを使います
（以前はマウスを実際に動かして貼り付けていました。押す場所を窓の中の割合で決めていたため、
画面の中身が少し変わると外れました）。

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
持っていなければなりません（メニューのキーが片方に無いと `cargo test --lib` が失敗します）。
画面に出る文字列を JS に直書きしないこと。必ずキーを足してください。

## 配布物を作る

```bash
./scripts/package-macos.sh
```

ビルド → ad-hoc 再署名（Tauri がビルド時に付ける署名はリソースが未封印で
`codesign --verify` が失敗する）→ dmg と zip を作成 → 受け取る人と同じ展開の仕方で検証、
までを通します。中のコメントを読んでから触ってください。各手順は、macOS で配布物が
壊れる具体的な経路それぞれへの対処です。

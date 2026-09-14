# 同梱物のライセンス

このリポジトリは以下を同梱しています。いずれもそれぞれのライセンスに従って使うもので、
本体の MIT（[LICENSE](LICENSE)）は適用されません。ライセンス全文は
下記のパスにコードと一緒に置いてあります。

English: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)

---

## foliate-js — MIT（改変あり）

- **場所**: `src/foliate-js/`
- **本家**: <https://github.com/johnfactotum/foliate-js>
- **著作権**: (c) 2022 John Factotum
- **ライセンス全文**: [`src/foliate-js/LICENSE`](src/foliate-js/LICENSE)

**このコピーには改変があります。** MIT は改変を認めていますが、どこを変えたかを
ここに記録します（ソース中では `※ foliate-js 本家からのローカル改変` のコメントで印を付けてあります）。

| ファイル | 変更 |
|---|---|
| `paginator.js` | 画像だけの面（表紙・口絵）を版面いっぱいに出す。そのセクションだけ段間と寸法上限を外し、`fillPageWithImage()` が画像をページ矩形に合わせる。あわせて、影の DOM に入れる版面の CSS を `<style>` 要素から構築済みスタイルシート（`adoptedStyleSheets`）へ移した。Tauri が CSP に nonce を足すと `<style>` 要素が遮断されるため。印付き 6 箇所。 |
| `quote-image.js` | 影の DOM の CSS を構築済みスタイルシートへ移した（理由は `paginator.js` と同じ）。印付き 1 箇所。 |
| `view.js` | このアプリがもう受け付けない文書形式の分岐を、その判定関数ごと削除した。印付き 2 箇所。 |
| `tts.js` | mark の名前から文の range を読むだけの `rangeOf()` を足した。読み上げ辞書の「この場所だけ」の登録を照合するのに、その文が章の何文字目から始まるかが要る。本家の `setMark()` だとハイライトが動いてしまうため、読み取るだけの関数を別に用意した。印付き 1 箇所。 |
| `epub.js` | 慣習メタ `<meta name="primary-writing-mode">` を metadata に足した。本家はこれを読まない。本文 CSS の writing-mode が落ちた縦書き本で、向きの最後の手掛かりに使う。印付き 1 箇所。 |

`src/foliate-js/` のそれ以外は本家のままです。

## zip.js（@zip.js/zip.js）— BSD-3-Clause

- **場所**: `src/foliate-js/vendor/zip.js`
- **本家**: <https://github.com/gildas-lormeau/zip.js>
- **著作権**: (c) 2022 Gildas Lormeau
- **ライセンス全文**: <https://github.com/gildas-lormeau/zip.js/blob/master/LICENSE>

同梱物は foliate-js の rollup ビルド（`src/foliate-js/rollup.config.js`）が作った
minify（空白や改行を削ってファイルを小さくする処理）を済ませたファイルです。その処理でファイル冒頭のライセンス表示も削られているので、帰属をここに記録します。

## fflate — MIT

- **場所**: `src/foliate-js/vendor/fflate.js`
- **本家**: <https://github.com/101arrowz/fflate>
- **著作権**: (c) 2023 Arjun Barrett
- **ライセンス全文**: <https://github.com/101arrowz/fflate/blob/master/LICENSE>

zip.js と同じ事情です（minify でファイル冒頭のライセンス表示が削られています）。

## Rust のクレート

Rust 側（`src-tauri/`）は Tauri とその依存を link します。いずれも MIT / Apache-2.0 です。
正確な構成とバージョンは [`src-tauri/Cargo.lock`](src-tauri/Cargo.lock) に固定されています。
全一覧が要るときは:

```bash
cargo install cargo-about && cargo about generate about.hbs
```

---

## 同梱していないもの

以下は**アプリが HTTP で話しかける別のプログラム**です。このリポジトリにもビルドした
アプリにも含まれていないので、各自でそれぞれの規約に従って導入してください。

- **VOICEVOX** — <https://voicevox.hiroshiba.jp/>
- **AivisSpeech** — <https://aivis-project.com/>
- **LM Studio** など OpenAI 互換のサーバー（翻訳を使う場合のみ・任意）

これらのエンジンが作った音声には、**使った音声ライブラリごとの規約**が付いてきます。
多くはキャラクター名のクレジット表記を求めています。このアプリから書き出した音声や動画を
公開する前に、使った声の規約を確認してください。

## 見本の本と画像

`test-books/` と `src/samples/` の中身は、すべてこのリポジトリのスクリプト
（`make_*.py`・`scripts/make-sample-images.py`・`scripts/make-sample-book.py`）が生成したもので、
本体と同じライセンスです。
第三者の書籍・写真・フォントは含まれていません。

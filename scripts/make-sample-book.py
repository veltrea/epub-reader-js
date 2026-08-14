#!/usr/bin/env python3
"""同梱サンプル本（`src/samples/sample-vertical.epub`）を生成する。

**これは初回起動でユーザーが最初に開く本になる。** 蔵書が空のときに 1 冊だけ入り、
書棚の見た目とリーダーの入口を兼ねる。だから中身は「読んで意味のある文章」にしてある——
以前は検証用の見本（「Readium が…を確かめるために作られた」）をそのまま同梱していて、
使う人には何のことか分からなかった。

内容はこのリーダーの案内そのもの。ついでに縦書き・ルビ・圏点・約物の見え方も出るので、
組版が壊れていればこの 1 冊で気づける。

    python3 scripts/make-sample-book.py
"""
import os
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "src", "samples", "sample-vertical.epub")

TITLE = "この本の読みかた"
AUTHOR = "EPUB Reader"
BOOK_ID = "urn:uuid:2f9a1c00-0000-4000-8000-samplebook01"

STYLE = """@charset "UTF-8";
html { writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl; }
body { font-family: "Hiragino Mincho ProN", "Yu Mincho", serif; line-height: 1.9; margin: 0; }
h1 { font-size: 1.4em; font-weight: normal; margin: 0 0 1.5em 0; letter-spacing: .1em; }
h2 { font-size: 1.1em; font-weight: normal; margin: 0 0 1em 0; }
p { text-indent: 1em; margin: 0 0 .2em 0; }
p.no-indent { text-indent: 0; }
.em { -webkit-text-emphasis: filled dot; text-emphasis: filled dot; }
rt { font-size: .5em; }
"""

# 節: (見出しレベル, 見出し, [段落…])
#
# **全部を 1 つの XHTML にまとめて出す。** foliate は spine の 1 項目ごとにページを組むので、
# ファイルを分けると 1 ファイルぶんで打ち切られ、**中身が少ないと右端に数列だけ立って
# 左が丸ごと空く**（不具合ではなく段組みの当たり前の帰結だが、初めて開いた人には壊れて見える）。
# 実測: 1 ファイル 843 字 → 8 列で終わり、画面の 1/3 しか埋まらなかった。
# 1 画面ぶんは **約 2100 字**（`test-books/vertical-long.epub` は 1 ファイル 2542 字で埋まる）。
# 節ごとに分けたいときは、ファイルではなく見出しで分けること。
PAGES = [
    ("h1", TITLE, [
        "この本は、いま開いているリーダーに最初から入っている案内です。"
        "ひととおりの使いかたが書いてあります。読み終えて用がなくなったら、"
        "書棚へ戻ってこの本を右クリックし、「削除」を選べば消えます。",
        "縦書きの本は、文字が上から下へ、行が右から左へと流れます。"
        "ページをめくる向きもそれに従って、右から左へ——つまり"
        "<span class=\"em\">左へ左へ</span>と進みます。横書きの本に慣れていると逆に感じますが、"
        "紙の本で日本語の小説を読むときと同じ動きです。"
        "いま読んでいるこの本がそのとおりになっていれば、組版は正しく効いています。",
        "このリーダーが縦書きを大事にしているのには理由があります。"
        "多くの電子書籍リーダーでは、日本語の縦書きは後回しにされがちで、"
        "行が画面の端で切れたり、読んでいるうちに文字が隠れてしまったりすることがあります。"
        "このリーダーは、縦でも横でも一ページを一つの箱として組むしくみを使っているので、"
        "そういう崩れかたが起きません。",
        "めくりかたはいくつもあります。手に馴染むものを使ってください。"
        "いちばん手軽なのは、<span class=\"em\">画面の左右の端をクリックする</span>方法です。"
        "本文の左端あたりを押せば先へ、右端あたりを押せば前へ戻ります"
        "（縦書きの本では、見た目のとおり左が「先」です）。",
        "キーボードなら矢印キーの ← と → が同じ働きをします。"
        "マウスのホイールを回してもページが変わります。"
        "一気に飛びたいときは、画面の下に出てくる進捗のつまみを動かしてください。"
        "本のどのあたりを読んでいるかも、そこで分かります。"
        "章ごとに飛びたいときは目次を開きます。本文の中を言葉で探すこともできます。",
        "読んでいた場所は自動で覚えています。本を閉じても、アプリを終了しても、"
        "次に開いたときは続きから始まります。"
        "気になったところに<span class=\"em\">しおり</span>を挟んでおくこともできます。"
        "しおりは何個でも置けて、あとから一覧から選んで戻れます。",
        "本文の見た目——文字の大きさ、行の間、余白、地の明るさ——は、"
        "あとから自由に変えられます。まずはこのまま読み進めてください。",
    ]),
    ("h2", "操作のボタンと、声で読ませること", [
        "本を開くと、本文だけが出て操作のボタンは見えなくなります。"
        "壊れているわけではありません。紙面をできるだけ広く使うために、"
        "普段は隠してあるのです。",
        "<span class=\"em\">マウスの矢印を画面のいちばん上か、いちばん下へ寄せてください。</span>"
        "上下から操作の帯がすっと出てきます。"
        "上の帯には「書棚へ戻る」「目次」「表示の設定」、"
        "下の帯には進捗のつまみと読み上げのボタンが並んでいます。"
        "矢印を本文へ戻すと、帯はまた隠れます。",
        "帯を出さなくても困りません。画面のいちばん上にあるメニューバーから、"
        "同じことがすべてできます。よく使うものには覚えやすい組み合わせが割り当ててあります。"
        "書棚へ戻るのは ⌘L、目次は ⌘T、本文の検索は ⌘F です。"
        "メニューバーは、その本でいま何ができるかも教えてくれます。"
        "灰色になっている項目は、いまの状態では使えないという意味です。",
        "このリーダーは本文を声で読み上げます。"
        "読んでいる文がその場で明るくなり、声の進みに合わせて色が伸びていくので、"
        "目で追いながら聞くことができます。章の終わりまで来れば、次の章へ自分で進みます。",
        "ただし<span class=\"em\">声を作る部分はこのアプリには入っていません</span>。"
        "VOICEVOX か AivisSpeech という別のソフトを先に起動しておいてください。"
        "どちらも無料で手に入ります。入っていない状態で読み上げを押すと、"
        "「エンジンに接続できません」と出て止まります。"
        "声の種類、話す速さ、句読点での間の長さは、設定から変えられます。"
        "長い本を聞くときは、少し速めにすると聞きやすくなります。",
        "人名や地名が思ったとおりに読まれないことがあります。"
        "そのときは「読み上げ辞書」に正しい読みを覚えさせてください。"
        "たとえば<ruby>斎<rt>いつき</rt></ruby>ひとし のように、"
        "字面からは読みの決まらない名前のためのしくみです。"
        "長い語を上に置けば、短い語に食われることもありません。",
        "読み上げている章は、音声ファイルとして書き出すこともできます。"
        "本文を映した動画として保存することもできます。",
    ]),
    ("h2", "組版のことと、自分の本を入れる", [
        "縦書きでは、<span class=\"em\">約物</span>——括弧や句読点、記号のたぐい——の置きかたで"
        "読みやすさがずいぶん変わります。"
        "「かぎ括弧」、句読点、感嘆符！ 疑問符？ ダッシュ―― 三点リーダ……。"
        "これらが行の頭や末で不格好に折れていないかを、この段落で確かめられます。",
        "<ruby>振<rt>ふ</rt></ruby>り<ruby>仮名<rt>がな</rt></ruby>も出せます。"
        "振り仮名は画面には小さく添えられますが、読み上げのときは読み飛ばします。"
        "同じ言葉を二度続けて読んでしまわないためです。",
        "文字の大きさ、行の間、余白、地の明るさ（明るい・セピア・暗い）は、"
        "上の帯の表示まわりから変えられます。"
        "全部の本に効く設定と、この本だけに効く設定を別々に持てるので、"
        "読みにくい一冊だけを直すこともできます。"
        "凝ったことをしたければ、自分で書いた指定を本文に足すこともできます。",
        "本の作りかたによっては、縦書きにするはずの指定が抜けていることがあります。"
        "そういう本でも、中身を見て縦書きらしいと判断できれば自動で縦に組み直します。"
        "それでも思ったとおりにならないときは、向きを手で決めてください。",
        "自分の本を入れるには、書棚に戻って「本を追加」を押すか、"
        "ウィンドウへ直接ドラッグしてください。"
        "フォルダごと落とせば、その中にある本をまとめて取り込みます。"
        "たくさんある場合は、取り込みの進みぐあいが表示されます。",
        "EPUB のほかに、漫画などの CBZ、FB2 も読めます。",
        "本が増えてきたら、書棚そのものを分けられます。"
        "「仕事用」と「趣味用」のように、蔵書も読みかけの場所も別々に持てます。"
        "分類を作って本を振り分けたり、よく読む本にしるしを付けたりもできます。"
        "作者名で並べ替えると、五十音で見出しが付きます。"
        "読みが取れない本は自分で直せるので、思ったところに並ばないときは"
        "本の読みを編集してみてください。",
        "それでは、よい読書を。",
    ]),
]


def document_xhtml():
    """全節を 1 つの XHTML にまとめる（節の区切りは見出しと id）。"""
    parts = []
    for i, (level, heading, paragraphs) in enumerate(PAGES, 1):
        parts.append(f'<section id="s{i}">')
        parts.append(f"<{level}>{heading}</{level}>")
        for j, para in enumerate(paragraphs):
            cls = ' class="no-indent"' if j == 0 else ""
            parts.append(f"<p{cls}>{para}</p>")
        parts.append("</section>")
    body = "\n".join(parts)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"
      xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>{TITLE}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
{body}
</body>
</html>
"""


CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def build():
    nav_items = "".join(
        f'<li><a href="text.xhtml#s{i}">{heading}</a></li>\n'
        for i, (_lvl, heading, _ps) in enumerate(PAGES, 1)
    )

    nav = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><h1>目次</h1><ol>
{nav_items}</ol></nav></body></html>
"""

    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"
         xml:lang="ja" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{BOOK_ID}</dc:identifier>
    <dc:title>{TITLE}</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>{AUTHOR}</dc:creator>
    <meta property="dcterms:modified">2026-08-10T00:00:00Z</meta>
    <meta name="primary-writing-mode" content="vertical-rl"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="text"/>
  </spine>
</package>
"""

    doc = document_xhtml()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        # mimetype は無圧縮で先頭に置く（EPUB の決まり）
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip",
                   compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        z.writestr("OEBPS/style.css", STYLE)
        z.writestr("OEBPS/text.xhtml", doc)

    import re as _re
    chars = len(_re.sub(r"\s+", "", _re.sub(r"<[^>]+>", "", doc)))
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes), {len(PAGES)} 節 / 本文 {chars} 字")


if __name__ == "__main__":
    build()

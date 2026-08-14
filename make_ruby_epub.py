#!/usr/bin/env python3
# 縦書きのルビ・縦中横・圏点を検証するための EPUB を生成。
#
# 見たいのは「破綻の不在」であって、エンジン間の一致ではない。具体的には
#   - ルビが行間に収まっているか（本文に重ならないか）
#   - 親文字より長いルビで行が壊れないか
#   - 縦中横（text-combine-upright）で数字が横に寝ているか
#   - 圏点（text-emphasis）が本文を押し出していないか
# 既存の test-books にルビを含む本が1冊も無かったので足す（2026-08-10）。
import os
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "test-books", "ruby-vertical.epub")

STYLE = """@charset "UTF-8";
html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }
body { font-family: serif; line-height: 1.9; margin: 1em; }
h1 { font-size: 1.3em; margin: 0 0 1em; }
/* 縦中横。2桁の数字を横に寝かせる */
.tcy { text-combine-upright: all; -webkit-text-combine: horizontal; }
/* 圏点 */
.em { text-emphasis: filled sesame; -webkit-text-emphasis: filled sesame; }
/* 何回目の繰り返しか分かるようにする目印。どのページを見ているか判別するために置く */
.mark { color: #888; }
"""

# ルビの書き方は2通りある。<rb> を使う古い形と、使わない形。
# EPUB の実物は両方出てくるので、両方入れておく。
PARAS = """<p>この本は<ruby><rb>組版</rb><rt>くみはん</rt></ruby>の検証に使う。
ルビが<ruby><rb>行間</rb><rt>ぎょうかん</rt></ruby>に収まらずに本文へ重なると読めなくなるので、
そこだけを見る。</p>

<p><ruby>親文字<rt>おやもじ</rt></ruby>より<ruby>長<rt>なが</rt></ruby>いルビも試す。
<ruby>躑躅<rt>つつじ</rt></ruby>や<ruby>薔薇<rt>ばら</rt></ruby>のような字は短いが、
<ruby>誕生日<rt>たんじょうび</rt></ruby>や
<ruby>吾輩<rt>わがはい</rt></ruby>のように<ruby>音<rt>おん</rt></ruby>が伸びる語では、
ルビのほうが<ruby>幅<rt>はば</rt></ruby>を食う。</p>

<p>数字は<span class="tcy">10</span>月<span class="tcy">25</span>日のように
<ruby><rb>縦中横</rb><rt>たてちゅうよこ</rt></ruby>で寝かせる。
<span class="tcy">99</span>まではこの形が使える。</p>

<p>強調には<span class="em">圏点</span>を打つ。
<span class="em">ここが大事だ</span>という指示が、行の幅を押し広げていないかを見る。</p>

<p>ルビと圏点と縦中横が<ruby><rb>同</rb><rt>おな</rt></ruby>じ行に来ることもある。
<span class="em">昭和</span><span class="tcy">64</span>年の
<ruby><rb>正月</rb><rt>しょうがつ</rt></ruby>、というような行だ。</p>

<p>段落を重ねて、複数の段（カラム）に分かれる状況も作る。
<ruby><rb>頁</rb><rt>ページ</rt></ruby>を繰り返し送っても、ルビの付いた行が
<ruby><rb>欠</rb><rt>か</rt></ruby>けたり、枠から<ruby><rb>溢</rb><rt>あふ</rt></ruby>れたり
しないことを確かめてほしい。</p>
"""

# 上の段落を何回並べるか。1 回だと本文が短すぎて **1 ページに収まってしまい**、
# ページ送りの検査（tests/smoke.mjs の「ページ送りで進む」）がこの本では成り立たない。
# 段落が複数のページに分かれることがこの見本の狙い（上の最後の段落に書いてある）なので、
# 何度か並べて数ページぶんの長さにする。
REPEAT = 6

BODY = "<h1>ルビ・縦中横・圏点の見本</h1>\n\n" + "\n".join(
    f'<p class="mark">— {i + 1} 回目 —</p>\n{PARAS}' for i in range(REPEAT)
)

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja">
<head><meta charset="UTF-8"/><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><h1>目次</h1><ol>
<li><a href="c001.xhtml">ルビ・縦中横・圏点の見本</a></li>
</ol></nav></body>
</html>
"""

# page-progression-direction="rtl" と primary-writing-mode で縦書き・右綴じを宣言する。
OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"
         prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:ruby-vertical-sample</dc:identifier>
    <dc:title>ルビ・縦中横・圏点の見本</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>veltrea</dc:creator>
    <meta property="dcterms:modified">2026-08-10T00:00:00Z</meta>
    <meta property="ibooks:binding">false</meta>
    <meta name="primary-writing-mode" content="vertical-rl"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c001" href="c001.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="c001"/>
  </spine>
</package>
"""

CHAPTER = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>ルビ・縦中横・圏点の見本</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
{BODY}
</body>
</html>
"""


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        # mimetype は無圧縮で先頭に置く（EPUB の決まり）
        z.writestr(
            zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED
        )
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/nav.xhtml", NAV)
        z.writestr("OEBPS/style.css", STYLE)
        z.writestr("OEBPS/c001.xhtml", CHAPTER)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()

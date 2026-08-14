#!/usr/bin/env python3
# 目次が 3 階層（部 → 章 → 節）ある EPUB を生成する。
#
# 目次サイドバーの折りたたみ（§9.9）を確かめるために作った（2026-08-14）。
# それまで test-books/ にも手元の蔵書にも**階層のある目次を持つ本が 1 冊も無く**、
# 折りたたみが正しく働くかを実機で見ることができなかった。
#
# 見たいのは次の 3 つ。
#   - 子を持つ項目にだけ三角が出るか（節には出ない）
#   - いま読んでいる章を含む枝だけが開いた状態で目次が出るか
#   - 三角を押すと閉じ、文字を押すとその章へ飛ぶか
#
#   python3 scripts/make-nested-toc-epub.py
import os
import zipfile

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "test-books",
    "nested-toc.epub",
)

# 部 → 章 → 節。折りたたみが無いと目次が 3 + 6 + 18 = 27 行になる。
PARTS = [
    ("第一部　港", [
        ("第一章　朝の汽笛", ["霧のなか", "荷を積む", "出航"]),
        ("第二章　名前のない船", ["甲板", "航海日誌", "最初の夜"]),
    ]),
    ("第二部　知らない土地", [
        ("第三章　上陸", ["港町の匂い", "通じない言葉", "宿を探す"]),
        ("第四章　迷い込んだ町", ["石畳の路地", "時計塔の下で", "見知らぬ親切"]),
    ]),
    ("第三部　帰る場所", [
        ("第五章　別れ", ["見送る人", "約束", "ふたたび汽笛"]),
        ("第六章　長い航路", ["変わらない水平線", "数えた日数", "港が見える"]),
    ]),
]

STYLE = """@charset "UTF-8";
html { writing-mode: vertical-rl; -epub-writing-mode: vertical-rl; }
body { font-family: serif; line-height: 1.9; margin: 1em; }
h1 { font-size: 1.3em; margin: 0 0 1em; }
h2 { font-size: 1.1em; margin: 2em 0 1em; }
"""

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

# 1 章 = 1 ファイル。節は同じファイルの中の id で指す（実際の本によくある形）。
# 版面が埋まる程度の分量を入れる。1 画面はおよそ 2100 字（HANDOVER §9-A-3 の実測）。
FILLER = (
    "潮の匂いが風に混じって流れてくる。石畳はまだ濡れていて、"
    "朝の光が水たまりの縁で細かく揺れていた。荷を担いだ人たちが列を作り、"
    "誰かが名前を呼ぶ声が、荷車の軋みに紛れて消えていく。"
)


def chapter_xhtml(ch_title, sections, sec_ids):
    body = [f"<h1>{ch_title}</h1>"]
    for (sec_title, sec_id) in zip(sections, sec_ids):
        body.append(f'<h2 id="{sec_id}">{sec_title}</h2>')
        body.append("<p>" + FILLER * 4 + "</p>")
        body.append("<p>" + FILLER * 4 + "</p>")
    inner = "\n".join(body)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>{ch_title}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
{inner}
</body>
</html>
"""


def build():
    files = {}          # ファイル名 -> 中身
    manifest = []
    spine = []
    nav_parts = []
    ch_no = 0

    for (part_title, chapters) in PARTS:
        nav_chapters = []
        for (ch_title, sections) in chapters:
            ch_no += 1
            name = f"c{ch_no:03d}.xhtml"
            sec_ids = [f"s{ch_no:03d}_{i + 1}" for i in range(len(sections))]
            files[name] = chapter_xhtml(ch_title, sections, sec_ids)
            manifest.append(
                f'    <item id="c{ch_no:03d}" href="{name}" '
                f'media-type="application/xhtml+xml"/>'
            )
            spine.append(f'    <itemref idref="c{ch_no:03d}"/>')
            nav_secs = "".join(
                f'<li><a href="{name}#{sid}">{st}</a></li>'
                for (st, sid) in zip(sections, sec_ids)
            )
            nav_chapters.append(
                f'<li><a href="{name}">{ch_title}</a><ol>{nav_secs}</ol></li>'
            )
        # 部の見出しは最初の章のファイルを指す（子を持つ見出し自体にも飛べること）
        first = nav_chapters[0].split('href="')[1].split('"')[0]
        nav_parts.append(
            f'<li><a href="{first}">{part_title}</a><ol>'
            + "".join(nav_chapters)
            + "</ol></li>"
        )

    nav = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja">
<head><meta charset="UTF-8"/><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><h1>目次</h1><ol>
{"".join(nav_parts)}
</ol></nav></body>
</html>
"""

    opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:nested-toc-sample</dc:identifier>
    <dc:title>目次が三階層ある本</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>veltrea</dc:creator>
    <meta property="dcterms:modified">2026-08-14T00:00:00Z</meta>
    <meta name="primary-writing-mode" content="vertical-rl"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
{chr(10).join(manifest)}
  </manifest>
  <spine page-progression-direction="rtl">
{chr(10).join(spine)}
  </spine>
</package>
"""
    return files, nav, opf


def main():
    files, nav, opf = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        # mimetype は無圧縮で先頭に置く（EPUB の決まり）
        z.writestr(
            zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED
        )
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/nav.xhtml", nav)
        z.writestr("OEBPS/style.css", STYLE)
        for name, text in files.items():
            z.writestr("OEBPS/" + name, text)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes) / 章 {len(files)} 個")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# 「見開き1枚の絵が左右2ページに分割」ケースの検証用 FXL EPUB。
# 左右ページは同一の絵(1200x800 の座標系)を、viewBox の窓だけずらして描く。
# 左右が継ぎ目なく密着すれば、円・対角線・横線が中央で連続して見える。
import zipfile, os

OUT = os.path.join(os.path.dirname(__file__), "test-books", "split-spread.epub")
PW, PH = 600, 800   # 1ページ
FW = PW * 2         # 見開き全幅 1200

# 全体(0..1200)に描く共通の絵。cx=600(継ぎ目)に円、対角線、中央横線、継ぎ目の点線。
def art():
    return f"""
  <circle cx="600" cy="400" r="300" fill="none" stroke="#e5484d" stroke-width="10"/>
  <line x1="0" y1="400" x2="1200" y2="400" stroke="#3b82f6" stroke-width="6"/>
  <line x1="0" y1="0" x2="1200" y2="800" stroke="#22c55e" stroke-width="6"/>
  <line x1="1200" y1="0" x2="0" y2="800" stroke="#22c55e" stroke-width="6"/>
  <text x="600" y="120" font-size="60" fill="#111" text-anchor="middle" font-family="sans-serif" font-weight="900">SPREAD</text>
  <line x1="600" y1="0" x2="600" y2="800" stroke="#888" stroke-width="2" stroke-dasharray="10 10"/>
"""

def page(n, vb_min_x, bg):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>p{n}</title>
<meta name="viewport" content="width={PW}, height={PH}"/>
<style>html,body{{margin:0;width:{PW}px;height:{PH}px}}</style></head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" width="{PW}" height="{PH}" viewBox="{vb_min_x} 0 {PW} {PH}">
  <rect x="{vb_min_x}" y="0" width="{PW}" height="{PH}" fill="{bg}"/>
  {art()}
</svg>
</body>
</html>
"""

# 表紙(単独) → 見開き左(p2, 左半分 x:0..600) | 見開き右(p3, 右半分 x:600..1200) → 末尾(単独)
COVER = page  # 使い回し
CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""
NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja">
<head><meta charset="UTF-8"/><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><h1>目次</h1><ol><li><a href="p1.xhtml">表紙</a></li><li><a href="p2.xhtml">見開き</a></li></ol></nav></body></html>
"""
OPF = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:2f9a1c00-0000-4000-8000-split0000001</dc:identifier>
    <dc:title>見開き分割検証見本</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>veltrea</dc:creator>
    <meta property="dcterms:modified">2026-07-24T00:00:00Z</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">both</meta>
    <meta name="viewport" content="width={PW}, height={PH}"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="p1" href="p1.xhtml" media-type="application/xhtml+xml"/>
    <item id="p2" href="p2.xhtml" media-type="application/xhtml+xml"/>
    <item id="p3" href="p3.xhtml" media-type="application/xhtml+xml"/>
    <item id="p4" href="p4.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="p1"/>
    <itemref idref="p2" properties="page-spread-left"/>
    <itemref idref="p3" properties="page-spread-right"/>
    <itemref idref="p4"/>
  </spine>
</package>
"""

os.makedirs(os.path.dirname(OUT), exist_ok=True)
if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", CONTAINER)
    z.writestr("OEBPS/content.opf", OPF)
    z.writestr("OEBPS/nav.xhtml", NAV)
    z.writestr("OEBPS/p1.xhtml", page(1, 0, "#fde68a"))       # 表紙(左半分の絵だが単独表示)
    z.writestr("OEBPS/p2.xhtml", page(2, 0, "#ffffff"))       # 見開き左半分 x:0..600
    z.writestr("OEBPS/p3.xhtml", page(3, PW, "#ffffff"))      # 見開き右半分 x:600..1200
    z.writestr("OEBPS/p4.xhtml", page(4, PW, "#fde68a"))      # 末尾
print("wrote", OUT, os.path.getsize(OUT), "bytes")

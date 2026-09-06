#!/usr/bin/env python3
# 固定レイアウト(FXL)検証用の最小 EPUB を生成。見開き2ページ表示の確認用。
import zipfile, os

OUT = os.path.join(os.path.dirname(__file__), "test-books", "fxl-sample.epub")
W, H = 600, 800

def page(n, color):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>p{n}</title>
<meta name="viewport" content="width={W}, height={H}"/>
<style>html,body{{margin:0;width:{W}px;height:{H}px}}
.pg{{width:{W}px;height:{H}px;background:{color};display:flex;align-items:center;justify-content:center;
font-family:sans-serif;font-size:72px;color:#fff;font-weight:900}}</style></head>
<body><div class="pg">{n}</div></body>
</html>
"""

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja">
<head><meta charset="UTF-8"/><title>目次</title></head>
<body><nav epub:type="toc" id="toc"><h1>目次</h1><ol>
<li><a href="p1.xhtml">1</a></li><li><a href="p3.xhtml">3</a></li></ol></nav></body></html>
"""

OPF = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:2f9a1c00-0000-4000-8000-fxl000000001</dc:identifier>
    <dc:title>FXL見開き検証見本</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>veltrea</dc:creator>
    <meta property="dcterms:modified">2026-07-24T00:00:00Z</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">both</meta>
    <meta name="viewport" content="width={W}, height={H}"/>
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
    <itemref idref="p2"/>
    <itemref idref="p3"/>
    <itemref idref="p4"/>
  </spine>
</package>
"""

colors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad"]
os.makedirs(os.path.dirname(OUT), exist_ok=True)
if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", CONTAINER)
    z.writestr("OEBPS/content.opf", OPF)
    z.writestr("OEBPS/nav.xhtml", NAV)
    for i, c in enumerate(colors, 1):
        z.writestr(f"OEBPS/p{i}.xhtml", page(i, c))
print("wrote", OUT, os.path.getsize(OUT), "bytes")

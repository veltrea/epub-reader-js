#!/usr/bin/env python3
# test-books/sample の横長画像を「真ん中で左右に分割」し、
# 左右見開き(page-spread-left/right)で1枚に結合する FXL(固定レイアウト)EPUB を生成する。
import zipfile, os, glob, io
from PIL import Image

HERE = os.path.dirname(__file__)
SRC_DIR = os.path.join(HERE, "test-books", "sample")
OUT = os.path.join(HERE, "test-books", "split-photobook.epub")

srcs = sorted(glob.glob(os.path.join(SRC_DIR, "*.jpg")) + glob.glob(os.path.join(SRC_DIR, "*.jpeg")) + glob.glob(os.path.join(SRC_DIR, "*.png")))
if not srcs:
    raise SystemExit("no images in " + SRC_DIR)

# 各画像を左右半分に分割。ページのビューポート = 半分の寸法。
halves = []   # [(name, jpeg_bytes, w, h), ...]  左→右の順
PW = PH = None
for i, path in enumerate(srcs, 1):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    half = w // 2
    if PW is None:
        PW, PH = half, h  # 代表ページ寸法(全画像同一 1280x720 前提)
    left = im.crop((0, 0, half, h))
    right = im.crop((half, 0, w, h))
    for side, img in (("left", left), ("right", right)):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        halves.append((f"{side}{i}", buf.getvalue(), img.size[0], img.size[1]))

def page_xhtml(n, imgname, w, h):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" lang="ja">
<head><meta charset="UTF-8"/><title>p{n}</title>
<meta name="viewport" content="width={w}, height={h}"/>
<style>html,body{{margin:0;padding:0;width:{w}px;height:{h}px}}
img{{display:block;width:{w}px;height:{h}px}}</style></head>
<body><img src="images/{imgname}.jpg" alt=""/></body>
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
""" + "".join(
    f'<li><a href="p{2*i-1}.xhtml">見開き {i}</a></li>\n' for i in range(1, len(srcs) + 1)
) + """</ol></nav></body></html>
"""

# manifest: nav + 画像(16) + ページ(16)
img_items = "".join(
    f'    <item id="img{k}" href="images/{name}.jpg" media-type="image/jpeg"/>\n'
    for k, (name, _b, _w, _h) in enumerate(halves, 1)
)
page_items = "".join(
    f'    <item id="pg{n}" href="p{n}.xhtml" media-type="application/xhtml+xml"/>\n'
    for n in range(1, len(halves) + 1)
)
# spine: 左=page-spread-left, 右=page-spread-right
spine = ""
for n in range(1, len(halves) + 1):
    prop = "page-spread-left" if (n % 2 == 1) else "page-spread-right"
    spine += f'    <itemref idref="pg{n}" properties="{prop}"/>\n'

OPF = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:2f9a1c00-0000-4000-8000-photobook001</dc:identifier>
    <dc:title>分割写真集見本</dc:title>
    <dc:language>ja</dc:language>
    <dc:creator>veltrea</dc:creator>
    <meta property="dcterms:modified">2026-07-24T00:00:00Z</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:spread">both</meta>
    <meta name="viewport" content="width={PW}, height={PH}"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
{img_items}{page_items}  </manifest>
  <spine>
{spine}  </spine>
</package>
"""

if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", CONTAINER)
    z.writestr("OEBPS/content.opf", OPF)
    z.writestr("OEBPS/nav.xhtml", NAV)
    for n, (name, data, w, h) in enumerate(halves, 1):
        z.writestr(f"OEBPS/images/{name}.jpg", data)
        z.writestr(f"OEBPS/p{n}.xhtml", page_xhtml(n, name, w, h))

print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes), {len(srcs)} images -> {len(halves)} pages ({len(srcs)} spreads), page={PW}x{PH}")

#!/usr/bin/env python3
"""全面ベタ塗りのアートワークを macOS のアプリアイコングリッドに合わせて焼き直す。

macOS は iOS と違い、Dock/Finder でアイコンに角丸マスクを自動適用しない。
アプリ側が Apple のグリッド（1024px キャンバスの中央に 824x824 の squircle、
周囲 100px は透明）を画像に焼き込んでおく必要がある。これをやらないと
Dock で 1 つだけ真四角に見える。

生成物:
  - icon.icns      … .app バンドル用（squircle 済み）
  - icon.png       … 1024px のマスター（squircle 済み）
  - 32/64/128/128@2x.png … Tauri の window / Linux 用

iOS・Android・Windows のアイコンは各 OS が独自にマスクするか全面表示が正しいので、
このスクリプトでは触らない（全面ベタ塗りのままが正解）。

入力は角丸を焼き込んでいない全面ベタ塗りの原版。既定では
src-tauri/icons/source/icon-fullbleed-1024.png を使う（icon.png は出力先なので
原版として使い回せない点に注意）。

使い方:
  python3 scripts/make-macos-icon.py [全面ベタ塗りソース.png] [--no-shadow]
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageFilter

# Apple のアイコングリッド（1024px 基準）
CANVAS = 1024
BODY = 824  # 角丸本体のサイズ。左右上下に 100px ずつ透明マージンが残る
# 角丸の形状。macOS 標準アプリ（Notes / Music / Preview）の icns から輪郭を実測して
# フィットした値。実測では本体は 1024 キャンバス内の (100,100)-(924,924)、
# 角の曲線は辺方向へ 214px（= 辺の 0.2604）伸び、指数 2.45 の superellipse に一致した。
CORNER_RATIO = 214.0 / 822  # 角の曲線が効く範囲。本体の一辺に対する比
SQUIRCLE_N = 2.45  # 角部 superellipse の指数。2.0 だと単なる円弧角丸になる
SS = 4  # スーパーサンプリング倍率。マスクのジャギー防止

# 影も同じ icns から実測。本体直下 alpha=109 から約 37px で 0 まで減衰する。
# 密着影と広がり影の 2 層で近似する: (alpha, blur, y オフセット) ※1024px 基準
SHADOW_LAYERS = [(110, 8, 2), (40, 26, 12)]

ICONSET_SIZES = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

# Tauri が bundle.icon で参照する PNG（macOS の window アイコン / Linux 用）
TAURI_PNGS = [("32x32.png", 32), ("64x64.png", 64), ("128x128.png", 128), ("128x128@2x.png", 256)]


def squircle_mask(size: int, n: float = SQUIRCLE_N) -> Image.Image:
    """Apple 流の連続角丸（辺は直線・角だけ superellipse）マスクを返す。

    角の領域を一辺 c の正方形とし、その中でのみ (dx/c)^n + (dy/c)^n <= 1 を判定する。
    領域の外＝辺の直線部分は無条件に塗る。n=2 なら普通の円弧角丸になり、
    n を上げるほど角が辺へ滑らかに溶ける（＝連続角丸）。
    """
    mask = Image.new("L", (size, size), 0)
    px = mask.load()
    c = size * CORNER_RATIO  # 角の曲線が効く範囲
    for y in range(size):
        # 上下どちらか近い方の辺からの距離。c を超えていれば直線部分
        qy = min(y + 0.5, size - (y + 0.5))
        dy = (c - qy) / c if qy < c else 0.0
        if dy >= 1.0:
            continue
        # dx^n <= 1 - dy^n を x について解く
        lim = (1.0 - dy**n) ** (1.0 / n)
        inset = c * (1.0 - lim)  # この行で角側から削られる幅
        x0 = int(round(inset))
        x1 = int(round(size - inset))
        for x in range(max(0, x0), min(size, x1)):
            px[x, y] = 255
    return mask


def build_master(src_path: Path, shadow: bool = True) -> Image.Image:
    src = Image.open(src_path).convert("RGBA")

    big_canvas = CANVAS * SS
    big_body = BODY * SS
    offset = (big_canvas - big_body) // 2

    body = src.resize((big_body, big_body), Image.LANCZOS)
    body.putalpha(squircle_mask(big_body))

    out = Image.new("RGBA", (big_canvas, big_canvas), (0, 0, 0, 0))

    if shadow:
        shape = squircle_mask(big_body)
        for alpha, blur, dy in SHADOW_LAYERS:
            layer = Image.new("RGBA", (big_canvas, big_canvas), (0, 0, 0, 0))
            layer.paste((0, 0, 0, alpha), (offset, offset + dy * SS), shape)
            out = Image.alpha_composite(out, layer.filter(ImageFilter.GaussianBlur(blur * SS)))

    out.paste(body, (offset, offset), body)
    return out.resize((CANVAS, CANVAS), Image.LANCZOS)


def main() -> int:
    icons_dir = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
    default_src = icons_dir / "source" / "icon-fullbleed-1024.png"

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    src_path = Path(args[0]) if args else default_src
    shadow = "--no-shadow" not in sys.argv

    if not src_path.exists():
        print(f"ソースが見つからない: {src_path}", file=sys.stderr)
        print(__doc__)
        return 1

    master = build_master(src_path, shadow=shadow)

    iconset = icons_dir.parent / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for name, size in ICONSET_SIZES:
        master.resize((size, size), Image.LANCZOS).save(iconset / name)

    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(icons_dir / "icon.icns")], check=True
    )
    subprocess.run(["rm", "-rf", str(iconset)], check=True)

    master.save(icons_dir / "icon.png")
    for name, size in TAURI_PNGS:
        master.resize((size, size), Image.LANCZOS).save(icons_dir / name)

    print(f"wrote {icons_dir}/icon.icns, icon.png, " + ", ".join(n for n, _ in TAURI_PNGS))
    return 0


if __name__ == "__main__":
    sys.exit(main())

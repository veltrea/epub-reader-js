#!/usr/bin/env python3
"""見開き検証用の横長画像を生成する（`test-books/sample/`）。

`make_split_photobook.py` の入力。真ん中で左右に割って左右ページに割り当てたとき、
**継ぎ目がずれていれば一目で分かる**絵であることだけが要件なので、写真は使わない
（配布物に第三者の画像を混ぜないため）。中央をまたぐ大きな円・対角線・横帯を置いて
あるので、1ページぶんずれると円が欠け、線が段違いになる。

    python3 scripts/make-sample-images.py

生成物は決定的（毎回同じ絵）。フォントを使わないので環境差も出ない。
"""
import math
import os

from PIL import Image, ImageDraw

W, H = 1280, 720
COUNT = 8
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(HERE, "test-books", "sample")


def hsv_rgb(h, s, v):
    """h は 0..360、s/v は 0..1。"""
    c = v * s
    x = c * (1 - abs(((h / 60) % 2) - 1))
    m = v - c
    r, g, b = [
        (c, x, 0), (x, c, 0), (0, c, x), (0, x, c), (x, 0, c), (c, 0, x)
    ][int(h // 60) % 6]
    return tuple(round((n + m) * 255) for n in (r, g, b))


def make(idx):
    """idx（1 始まり）ごとに色相をずらした 1 枚を作る。"""
    base = (idx - 1) * (360 / COUNT)
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)

    # 背景: 左から右への横グラデーション（左右に割ったとき、継ぎ目で色が連続するか見える）
    left = hsv_rgb(base, 0.45, 0.30)
    right = hsv_rgb((base + 40) % 360, 0.55, 0.75)
    for x in range(W):
        f = x / (W - 1)
        d.line(
            [(x, 0), (x, H)],
            fill=tuple(round(left[i] + (right[i] - left[i]) * f) for i in range(3)),
        )

    cx, cy = W / 2, H / 2

    # 中央をまたぐ同心円。ずれると円が段違いになる。
    for r in range(60, 340, 40):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255), width=3)

    # 対角線（四隅から中心へ）。ずれると中心で折れる。
    for a, b in (((0, 0), (W, H)), ((W, 0), (0, H))):
        d.line([a, b], fill=(255, 255, 255), width=2)

    # 中央縦線をまたぐ横帯。継ぎ目のずれが px 単位で分かる目盛り。
    for k in range(-6, 7):
        y = cy + k * 48
        d.line([(cx - 320, y), (cx + 320, y)], fill=(0, 0, 0), width=1)
    for k in range(-8, 9):
        x = cx + k * 40
        d.line([(x, cy - 300), (x, cy + 300)], fill=(0, 0, 0), width=1)

    # 中央の縦の切れ目そのもの（ここで割られる）
    d.line([(cx, 0), (cx, H)], fill=(255, 80, 80), width=2)

    # 通し番号（数字はフォントを使わず、点の並びで表す＝環境差なし）
    for n in range(idx):
        x = 40 + n * 34
        d.ellipse([x, 40, x + 22, 62], fill=(255, 255, 255), outline=(0, 0, 0), width=2)

    # 左右どちら側かの目印（左＝三角が右向き、右＝三角が左向き）
    d.polygon([(60, H - 60), (60, H - 120), (110, H - 90)], fill=(255, 255, 255))
    d.polygon([(W - 60, H - 60), (W - 60, H - 120), (W - 110, H - 90)], fill=(255, 255, 255))

    # 中央にかかる大きな弧（円の一部）。左右がぴたり合うかの決め手。
    for r, wdt in ((330, 6), (300, 3)):
        d.arc([cx - r, cy - r, cx + r, cy + r], start=200, end=340, fill=(20, 20, 20), width=wdt)

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for i in range(1, COUNT + 1):
        path = os.path.join(OUT_DIR, f"spread-{i:02d}.jpg")
        make(i).save(path, format="JPEG", quality=88, optimize=True)
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")
    print(f"{COUNT} images, {W}x{H} each -> {OUT_DIR}")


if __name__ == "__main__":
    main()

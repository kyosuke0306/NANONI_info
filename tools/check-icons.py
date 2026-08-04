#!/usr/bin/env python3
"""
書き出したアイコンを確かめる。

  pip install Pillow      # 初回のみ
  python3 tools/check-icons.py

見ているのは3つ。

  1. アルファ（透明）が残っていないか
     iOS は透明部分を黒で塗りつぶすので、残っていると黒い四角になる。

  2. 四隅が白いか
     白い紙の上にちゃんと重なっているか。

  3. 絵柄が中心から半径40%の円に収まっているか
     Android は丸く切り抜く（maskable）。はみ出すと欠ける。
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow が必要です:  pip install Pillow")

ASSETS = Path(__file__).resolve().parent.parent / "assets"
FILES = ["icon-src.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"]

SAFE_RATIO = 0.40      # 丸マスクの安全圏。中心から「一辺 × 0.40」まで
WHITE = 250            # これ以上は白＝背景とみなす


def check(path):
    im = Image.open(path)
    size = im.size[0]
    ng = []

    has_alpha = im.mode in ("RGBA", "LA", "PA") or "transparency" in im.info
    if has_alpha:
        ng.append("アルファが残っている")

    rgb = im.convert("RGB")
    w, h = rgb.size
    # 原本は撮り込みのムラで 253 などになっていることがある。
    # make-icons.py が白に寄せるので、ほぼ白なら通す。
    corners = [rgb.getpixel(p) for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]]
    if not all(min(c) >= 250 for c in corners):
        ng.append(f"四隅が白くない {corners}")

    # 中心からいちばん遠い「白でない点」を探す
    g = rgb.convert("L")
    px = g.load()
    cx = cy = (size - 1) / 2
    far = 0.0
    for y in range(h):
        for x in range(w):
            if px[x, y] < WHITE:
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if d > far:
                    far = d

    safe = size * SAFE_RATIO
    ratio = far / size
    if far > safe:
        ng.append(f"丸マスクからはみ出す（中心から {ratio:.1%}／上限 {SAFE_RATIO:.0%}）")

    state = "OK" if not ng else "NG"
    print(f"[{state}] {path.name:<22} {size}x{size} {im.mode}"
          f"  透明なし={not has_alpha}"
          f"  絵柄の広がり={ratio:.1%}（上限 {SAFE_RATIO:.0%}）")
    for m in ng:
        print(f"       → {m}")
    return not ng


def main():
    ok = True
    for name in FILES:
        p = ASSETS / name
        if not p.exists():
            print(f"[NG] {name} がありません")
            ok = False
            continue
        ok = check(p) and ok

    print()
    print("すべて問題なし。" if ok else "問題があります。上の → を見てください。")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

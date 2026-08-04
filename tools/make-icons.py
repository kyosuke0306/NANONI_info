#!/usr/bin/env python3
"""
assets/icon-src.png から、ホーム画面アイコン用の PNG を書き出す。

  pip install Pillow          # 初回のみ
  python3 tools/make-icons.py

生成されるもの

  apple-touch-icon.png  180×180。iOS のホーム画面
                        ★これが無いと iOS はページのスクショを縮小して使う
  icon-192.png          192×192。Android（site.webmanifest）
  icon-512.png          512×512。Android（スプラッシュ・丸マスク兼用）
  favicon.svg           ブラウザのタブ（icon-192.png を埋め込んだもの）

作りかたの決まりごと（実機で確かめて分かったこと）

  * 大きさは 180×180 ちょうどにする。
    512×512 を置いたら、iOS がぼかして描いた。
  * 色は RGB のまま扱う。白黒（グレースケール）に変換しない。
  * 縮小は Pillow の LANCZOS でおこなう。
  * 地の色は四隅から読み取る。その色の紙に重ねてアルファを捨てる
    （透明を残すと iOS がそこを黒く塗りつぶす）。

原本は 1024×1024 の正方形にすること。角丸は付けない（端末側で丸められる）。
絵柄は中心から半径40%の円に収めること（Android が丸く切り抜くため）。
書き出したあとは tools/check-icons.py で確かめる。
"""

import base64
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow が必要です:  pip install Pillow")

ASSETS = Path(__file__).resolve().parent.parent / "assets"
SRC = ASSETS / "icon-src.png"

OUT = [(180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")]


def main():
    if not SRC.exists():
        sys.exit(f"原本がありません: {SRC}")

    src = Image.open(SRC)

    # 地の色は四隅から読み取る（白地でも暗い地でも同じ手順で扱えるように）
    probe = src.convert("RGB")
    w, h = probe.size
    bg = probe.getpixel((0, 0))

    # その色の紙に重ねてアルファを捨てる。RGB のまま扱う（白黒に変換しない）
    base = Image.new("RGB", src.size, bg)
    base.paste(src, (0, 0), src if src.mode in ("RGBA", "LA", "PA") else None)

    for size, name in OUT:
        im = base.resize((size, size), Image.LANCZOS)
        im.save(ASSETS / name, format="PNG", optimize=True)
        print(f"書き出し: assets/{name} ({size}x{size})")

    # タブ用は SVG。小さい PNG を favicon にすると、iOS がホーム画面の
    # アイコンをそこから作ってしまうことがある。SVG なら大きさに縛られない。
    b64 = base64.b64encode((ASSETS / "icon-192.png").read_bytes()).decode("ascii")
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" role="img" aria-label="NANONI">\n'
        '  <rect width="192" height="192" fill="#ffffff"/>\n'
        f'  <image x="0" y="0" width="192" height="192" href="data:image/png;base64,{b64}"/>\n'
        "</svg>\n"
    )
    (ASSETS / "favicon.svg").write_text(svg, encoding="utf-8")
    print(f"書き出し: assets/favicon.svg ({len(svg) / 1024:.0f}KB)")

    print("\n完了。端末で確認するときはホーム画面から削除して追加し直してください。")


if __name__ == "__main__":
    main()

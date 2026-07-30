#!/usr/bin/env python3
"""
NANONI 関係者限定サイト — 本文の暗号化 / 復号ツール

このリポジトリは public なので、本文の平文（src/content.html）はコミットしない。
リポジトリに入るのは暗号文（payload.js）だけ。

使い方
------

  # 本文を暗号化して payload.js を生成（公開するのはこれ）
  python3 tools/build.py encrypt --in src/content.html --out payload.js

  # payload.js から本文を復元（編集したいとき）
  python3 tools/build.py decrypt --in payload.js --out src/content.html

パスワードは対話的に聞かれる。CI等で使う場合は環境変数 NANONI_PASSWORD でも渡せる。

暗号仕様（assets/app.js の復号処理と対応）
  鍵導出 : PBKDF2-HMAC-SHA256, salt 16バイト（ランダム）, 310,000回
  暗号化 : AES-256-GCM, IV 12バイト（ランダム）, 認証タグ128ビット
"""

import argparse
import base64
import getpass
import json
import os
import re
import sys
from datetime import date

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
except ImportError:
    sys.exit("cryptography が必要です:  pip install cryptography")

ITERATIONS = 310_000
BANNER = (
    "/* NANONI / 24CLUB — 関係者限定資料の暗号化ペイロード\n"
    " * 本文は AES-256-GCM で暗号化されています。正しいパスワードなしでは復号できません。\n"
    " * 編集手順:  python3 tools/build.py decrypt  →  src/content.html を編集  →  encrypt\n"
    " */\n"
)


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def derive(password: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS
    ).derive(password.encode("utf-8"))


def ask_password(confirm: bool) -> str:
    env = os.environ.get("NANONI_PASSWORD")
    if env:
        return env
    pw = getpass.getpass("パスワード: ")
    if not pw:
        sys.exit("パスワードが空です。")
    if confirm and pw != getpass.getpass("パスワード（確認）: "):
        sys.exit("パスワードが一致しません。")
    return pw


def encrypt(src: str, dest: str) -> None:
    with open(src, encoding="utf-8") as fh:
        plaintext = fh.read()

    password = ask_password(confirm=True)
    salt = os.urandom(16)
    iv = os.urandom(12)
    ciphertext = AESGCM(derive(password, salt)).encrypt(
        iv, plaintext.encode("utf-8"), None
    )

    payload = {
        "v": 1,
        "iterations": ITERATIONS,
        "salt": b64(salt),
        "iv": b64(iv),
        "ct": b64(ciphertext),
        "built": date.today().strftime("%Y/%m/%d"),
    }

    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(BANNER)
        fh.write("window.NANONI_PAYLOAD = ")
        fh.write(json.dumps(payload, ensure_ascii=False, indent=2))
        fh.write(";\n")

    print(f"暗号化しました: {dest}  ({len(plaintext):,} 文字 → {len(ciphertext):,} バイト)")


def decrypt(src: str, dest: str) -> None:
    with open(src, encoding="utf-8") as fh:
        text = fh.read()

    match = re.search(r"window\.NANONI_PAYLOAD\s*=\s*(\{.*?\});\s*$", text, re.S)
    if not match:
        sys.exit(f"{src} からペイロードを読み取れませんでした。")
    payload = json.loads(match.group(1))

    password = ask_password(confirm=False)
    key = derive(password, base64.b64decode(payload["salt"]))
    try:
        plaintext = AESGCM(key).decrypt(
            base64.b64decode(payload["iv"]), base64.b64decode(payload["ct"]), None
        )
    except Exception:
        sys.exit("復号に失敗しました。パスワードが違います。")

    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(plaintext.decode("utf-8"))
    print(f"復号しました: {dest}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["encrypt", "decrypt"])
    parser.add_argument("--in", dest="src", required=True)
    parser.add_argument("--out", dest="dest", required=True)
    args = parser.parse_args()

    (encrypt if args.mode == "encrypt" else decrypt)(args.src, args.dest)


if __name__ == "__main__":
    main()

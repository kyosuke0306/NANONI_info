# NANONI_info

NANONI / 24CLUB の**関係者限定**事業情報サイト。ブランド体制・商品・原価・OEM契約条件・在庫・課題を
一覧できる内部資料を、パスワードを入れないと読めない形で公開する。

- 目次つきの1ページ資料（キーワード絞り込み・印刷/PDF出力対応）
- スマートフォン / ダークモード対応
- `noindex` 指定で検索エンジンには載らない

---

## ⚠️ このリポジトリは public です

そのため、**単なるJavaScriptのパスワード判定では意味がありません**（ソースを見れば本文が読めてしまう）。
このサイトは本文自体を **AES-256-GCM で暗号化**し、パスワードから鍵を導出してブラウザ内で復号しています。

| | |
|---|---|
| 鍵導出 | PBKDF2-HMAC-SHA256 / salt 16バイト / **310,000回** |
| 暗号化 | AES-256-GCM（IV 12バイト・認証タグ128ビット） |
| 復号 | ブラウザの WebCrypto API（`assets/app.js`） |

つまり **正しいパスワードなしでは、`payload.js` を落としても本文は復元できません。**
リポジトリには暗号文だけを置き、平文（`src/content.html`）は `.gitignore` でコミット対象外にしています。

### パスワードの扱い

**パスワードはこのリポジトリには書きません。** README や commit に書いてしまうと、
暗号化している意味がなくなります（公開リポジトリなので誰でも読めてしまう）。

関係者へは GitHub 以外の経路（口頭・チャットのDM など）で個別に共有してください。
分からなくなった場合は、パスワードを知っているメンバーに聞くか、
後述の手順で新しいパスワードに変更してください。

**より強く守りたい場合は、リポジトリ自体を private にするのが確実です。**
そのうえで GitHub Pages を使うなら、Pages の公開範囲設定（Private Pages）も併せて確認してください。
暗号化はあくまで「public のまま置くための最低ライン」です。

---

## 公開のしかた（GitHub Pages）

1. GitHub の **Settings → Pages** を開く
2. **Source** を `Deploy from a branch`、**Branch** を `main` / `(root)` に設定
3. 数分後 `https://kyosuke0306.github.io/NANONI_info/` で公開される

---

## 通常版と簡易版

2つのページがあります。サイドバー下部のボタンでいつでも行き来でき、
一度パスワードを入れれば同じタブ内では再入力を求められません。

| | 通常版 `index.html` | 簡易版 `simple.html` |
|---|---|---|
| 内容 | 図・表・説明をすべて掲載 | **図だけ** |
| 章の数 | 15 | 5 |
| 図の数 | 15 | 8 |
| 表・注記・囲み | あり | なし |
| キーワード絞り込み | あり | なし |
| ページの長さ | 約16,100px | 約3,800px |

**本文は1つしか持っていません。** `payload.js`（暗号化された本文）は共通で、
簡易版は復号したあとに図以外を取り除いて表示しています。
そのため資料を更新するときは `src/content.html` を直すだけで、両方に反映されます。

### 簡易版での出し分け

図を1つ足せば両方に出ます。表や説明文を足した場合は通常版にだけ出ます。
それに加えて、**本文側の属性で個別に指定**できます（`assets/app.js` にタイトルを
書かないので、文言を直しても壊れません）。

| 属性 | 効果 | 書く場所 |
|---|---|---|
| `data-simple="hide"` | 簡易版では表示しない | `<section>` または `<figure class="viz">` |
| `data-simple-title="…"` | 簡易版でだけ別の見出しにする | `<h2>` |

```html
<!-- 簡易版には出さない図 -->
<figure class="viz" data-simple="hide"> … </figure>

<!-- 簡易版には出さない章 -->
<section id="license" data-simple="hide"> … </section>

<!-- 通常版は「15. まとめと今後」、簡易版は「今後のスケジュール」 -->
<h2 data-simple-title="今後のスケジュール">15. まとめと今後</h2>
```

図が1つも残らない章は、簡易版では章ごと表示されません。
簡易版の見出しからは章番号を自動で外しています（通常版と番号がとびとびになるため）。

---

## 中身を書き換える

平文はリポジトリに入っていないので、**復号 → 編集 → 再暗号化**の順で作業します。

```bash
pip install cryptography          # 初回のみ

# 1. payload.js から本文を復元（パスワードを聞かれる）
python3 tools/build.py decrypt --in payload.js --out src/content.html

# 2. src/content.html を編集
#    <section id="..."> と <h2> を足すだけで、目次には自動で追加される

# 3. 再暗号化（payload.js を更新）
python3 tools/build.py encrypt --in src/content.html --out payload.js

# 4. コミット & プッシュ（src/content.html は .gitignore 済みなので入りません）
git add payload.js && git commit -m "資料を更新" && git push
```

### パスワードを変更する

上の手順3で新しいパスワードを入力するだけです。`payload.js` を作り直せば古いパスワードは無効になります。
変更後は、新しいパスワードを関係者へ GitHub 以外の経路で共有してください。

> **注意**：うっかりパスワードを commit してしまった場合、後のコミットで消しても
> 履歴からは読めてしまいます。その場合は履歴を書き換えたうえで、
> パスワード自体も新しいものに変更してください（漏れたものとして扱う）。

---

## ローカルで確認する

`file://` で直接開くと WebCrypto が動かないため、簡易サーバー経由で開いてください。

```bash
python3 -m http.server 8000
# → http://localhost:8000/
```

---

## ファイル構成

```
index.html              通常版のページ（ロック画面 + 本体の骨組み）
simple.html             簡易版のページ（図だけを表示）
payload.js              暗号化された本文（★リポジトリに入るのはこれだけ）
manifest.webmanifest    ホーム画面アイコン・表示名（Android Chrome 用）
assets/style.css        スタイル（ライト/ダーク・印刷対応）
assets/app.js           復号・目次生成・スクロール連動・キーワード絞り込み
assets/icon.svg         アイコンの原本（これを編集して PNG を作り直す）
assets/icon-*.png       32/180/192/512。180 は iOS、192・512 は Android が使う
tools/build.py          暗号化 / 復号ツール
tools/make-icons.js     icon.svg から PNG を生成する
src/content.html        本文の平文（.gitignore 対象。commit されません）
```

## ホーム画面アイコンを変える

`assets/icon.svg` を編集してから PNG を作り直します。

```bash
npm install playwright-core     # 初回のみ
node tools/make-icons.js        # icon.svg → icon-32/180/192/512.png
```

アイコンの割り当ては次のとおりです。

| 対象 | 使われるファイル | 指定場所 |
|---|---|---|
| iOS（ホーム画面） | `assets/icon-180.png` | `index.html` の `apple-touch-icon` |
| iOS（アイコン下の名前） | — | `index.html` の `apple-mobile-web-app-title` |
| Android Chrome | `assets/icon-192.png` / `icon-512.png` | `manifest.webmanifest` |
| Android（表示名） | — | `manifest.webmanifest` の `short_name` |
| ブラウザのタブ | `assets/icon.svg` / `icon-32.png` | `index.html` の `rel="icon"` |

> **iOS は SVG も manifest も見ません。** `apple-touch-icon` の PNG がないと、
> ホーム画面にはページのスクリーンショットが縮小されて置かれます。

> **アイコンを変えても端末側では古いまま表示されます。**
> iOS・Android とも強くキャッシュするため、確認するときは
> **ホーム画面から一度削除して、追加し直してください。**

## 使い方のメモ

| 操作 | 動作 |
|---|---|
| `/` キー | キーワード絞り込みにフォーカス |
| `Esc` | 絞り込み解除 / モバイルの目次を閉じる |
| 「印刷 / PDF」 | 目次やボタンを除いた印刷レイアウトで出力 |
| 「ロック」 | 復号状態を破棄してロック画面に戻る |

解錠状態は**同じタブの間だけ**保持されます（タブを閉じると再入力）。

---

情報の取り扱いは資料内「0. 情報の取り扱いルール」に従うこと。
事実確認の基準は **発注書 / 請求書 / 在庫スプレッドシート / IBとのメール**で、このサイトも一次資料ではありません。

#!/usr/bin/env node
/*
 * assets/icon-src.png から、ホーム画面アイコン用の PNG を書き出す。
 *
 *   npm install playwright-core     # 初回のみ
 *   node tools/make-icons.js
 *
 * 生成されるもの（明るい画面むけ／暗い画面むけ の2組）
 *   icon-32.png  / icon-dark-32.png    ブラウザのタブ
 *   icon-180.png / icon-dark-180.png   iOS のホーム画面（apple-touch-icon）
 *                                      ★これが無いと iOS はスクショを使う
 *   icon-192.png / icon-dark-192.png   Android Chrome（manifest）
 *   icon-512.png / icon-dark-512.png   Android Chrome（manifest／maskable 兼用）
 *
 * 暗い画面むけは、原本の白と黒を「サイトの暗い配色」に置き換えて作る。
 * 原本は1つだけなので、絵柄を変えるときは assets/icon-src.png を差し替えて
 * これを流し直せば、両方とも作り直される。
 *
 * 元絵は 1024×1024 の正方形・白背景に黒の絵柄・不透明にすること
 * （iOS は透明部分を黒で塗りつぶすため）。
 * なお端末はアイコンを強くキャッシュするので、確認するときは
 * ホーム画面から一度削除して追加し直すこと。
 */

const fs = require('fs');
const path = require('path');

const SIZES = [32, 180, 192, 512];
const ASSETS = path.join(__dirname, '..', 'assets');
const SRC = path.join(ASSETS, 'icon-src.png');

// 暗い画面むけの2色。サイトの暗い配色（style.css の --bg / --ink）に合わせてある
const DARK_BG  = [0x16, 0x15, 0x0f];
const DARK_INK = [0xec, 0xe7, 0xdc];

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core が必要です:  npm install playwright-core');
  process.exit(1);
}

// この環境では Chromium が同梱されている。無ければ playwright-core の既定に任せる。
const BUNDLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = fs.existsSync(BUNDLED) ? { executablePath: BUNDLED } : {};

(async () => {
  const src = 'data:image/png;base64,' + fs.readFileSync(SRC).toString('base64');
  const browser = await chromium.launch(launchOptions);

  for (const size of SIZES) {
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(
        `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:#fff}
         canvas{display:block;width:${size}px;height:${size}px}</style><canvas></canvas>`,
        { waitUntil: 'load' }
      );

      await page.evaluate(async ({ src, size, dark, bg, ink }) => {
        const img = new Image();
        img.src = src;
        await img.decode();

        const cv = document.querySelector('canvas');
        cv.width = cv.height = size;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        if (!dark) return;

        // 原本の白（背景）→ 暗い地色、黒（絵柄）→ 明るい文字色。
        // 端のなめらかさを保つため、あいだの灰色はそのまま2色の中間へ移す。
        const d = ctx.getImageData(0, 0, size, size);
        for (let i = 0; i < d.data.length; i += 4) {
          const t = d.data[i] / 255;           // 0=絵柄 1=背景（原本は白黒なのでRだけで足りる）
          for (let c = 0; c < 3; c++) {
            d.data[i + c] = Math.round(ink[c] + (bg[c] - ink[c]) * t);
          }
        }
        ctx.putImageData(d, 0, 0);
      }, { src, size, dark, bg: DARK_BG, ink: DARK_INK });

      const name = `icon-${dark ? 'dark-' : ''}${size}.png`;
      await page.locator('canvas').screenshot({ path: path.join(ASSETS, name) });
      await page.close();
      console.log(`書き出し: assets/${name} (${size}x${size})`);
    }
  }

  await browser.close();
  console.log('\n完了。端末で確認するときはホーム画面から削除して追加し直してください。');
})();

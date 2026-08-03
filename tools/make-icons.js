#!/usr/bin/env node
/*
 * assets/icon-src.png から、ホーム画面アイコン用の PNG を書き出す。
 *
 *   npm install playwright-core     # 初回のみ
 *   node tools/make-icons.js
 *
 * 生成されるもの
 *   icon-32.png   ブラウザのタブ（SVG 非対応環境むけの控え）
 *   icon-180.png  iOS のホーム画面（apple-touch-icon）★これが無いと iOS はスクショを使う
 *   icon-192.png  Android Chrome（manifest）
 *   icon-512.png  Android Chrome（manifest／スプラッシュ・maskable 兼用）
 *
 * アイコンの絵柄を変えるときは assets/icon-src.png だけ差し替えて、これを流し直す。
 * 元絵は 1024×1024 の正方形・背景は不透明にすること
 * （iOS は透明部分を黒で塗りつぶすため）。
 * なお端末はアイコンを強くキャッシュするので、確認するときは
 * ホーム画面から一度削除して追加し直すこと。
 */

const fs = require('fs');
const path = require('path');

const SIZES = [32, 180, 192, 512];
const ASSETS = path.join(__dirname, '..', 'assets');
const SRC = path.join(ASSETS, 'icon-src.png');

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
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:#fff}
       img{display:block;width:${size}px;height:${size}px}</style><img src="${src}" alt="">`,
      { waitUntil: 'load' }
    );
    await page.waitForFunction(() => {
      const img = document.querySelector('img');
      return img && img.complete && img.naturalWidth > 0;
    });
    const out = path.join(ASSETS, `icon-${size}.png`);
    await page.screenshot({ path: out });
    await page.close();
    console.log(`書き出し: assets/icon-${size}.png (${size}x${size})`);
  }

  await browser.close();
  console.log('\n完了。端末で確認するときはホーム画面から削除して追加し直してください。');
})();

#!/usr/bin/env node
/*
 * assets/icon-src.png から、ホーム画面アイコン用の PNG を書き出す。
 *
 *   npm install playwright-core     # 初回のみ
 *   node tools/make-icons.js
 *
 * 生成されるもの
 *   apple-touch-icon.png  512px。iOS のホーム画面
 *                         ★これが無いと iOS はページのスクショを縮小して使う
 *                         180px でも足りるはずだが、実機でぼけて描かれたため
 *                         大きめにしてある（縮小なら必ずくっきりする）
 *   icon-192.png          Android Chrome（site.webmanifest）
 *   icon-512.png          Android Chrome（site.webmanifest／スプラッシュ・丸マスク兼用）
 *
 * どれも白い紙の上に描いてから撮るので、原本にアルファがあっても
 * 白で塗りつぶされ、アルファの無い PNG になる
 * （iOS は透明部分を黒で塗りつぶすため、アルファを残してはいけない）。
 *
 * アイコンの絵柄を変えるときは assets/icon-src.png だけ差し替えて、これを流し直す。
 * 元絵は 1024×1024 の正方形にすること。
 * Android は丸く切り抜くので、絵柄は中心から半径40%の円に収めること
 * （tools/check-icons.py で確かめられる）。
 * なお端末はアイコンを強くキャッシュするので、確認するときは
 * ホーム画面から一度削除して追加し直すこと。
 */

const fs = require('fs');
const path = require('path');

// 出す大きさと、その名前
const OUT = [[512, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'icon-512.png']];
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

  for (const [size, name] of OUT) {
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
    await page.screenshot({ path: path.join(ASSETS, name) });
    await page.close();
    console.log(`書き出し: assets/${name} (${size}x${size})`);
  }

  await browser.close();

  // タブ用の favicon は SVG にする。
  // 小さい PNG を favicon にすると、iOS がホーム画面のアイコンを
  // その小さい画像から作ってしまい、引き伸ばされてぼける。
  // SVG なら何倍に描かれても大きさに縛られない。
  // 絵柄は図形ではなく画像なので、512px の PNG を中に埋め込んでいる。
  const b64 = fs.readFileSync(path.join(ASSETS, 'icon-512.png')).toString('base64');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="NANONI">\n' +
    '  <rect width="512" height="512" fill="#ffffff"/>\n' +
    `  <image x="0" y="0" width="512" height="512" href="data:image/png;base64,${b64}"/>\n` +
    '</svg>\n';
  fs.writeFileSync(path.join(ASSETS, 'favicon.svg'), svg);
  console.log(`書き出し: assets/favicon.svg (${(svg.length / 1024).toFixed(0)}KB)`);

  console.log('\n完了。端末で確認するときはホーム画面から削除して追加し直してください。');
})();

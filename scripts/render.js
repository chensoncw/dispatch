#!/usr/bin/env node
/**
 * render.js â€” turn a card record into a 1080x1080 PNG.
 *
 *   node scripts/render.js content/2026-09-29-market.json
 *   node scripts/render.js            # renders everything in content/
 *
 * Writes out/<name>.png. The renderer (render.html) reads card.json sitting
 * beside it, so this writes that file, screenshots, then cleans it up.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const CARD_FILE = path.join(ROOT, 'card.json');

async function main() {
  let files = process.argv.slice(2);
  if (!files.length) {
    const dir = path.join(ROOT, 'content');
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f))
      : [];
  }
  if (!files.length) {
    console.log('render: nothing to render');
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1080, height: 1080 },
    deviceScaleFactor: 1
  });

  for (const file of files) {
    const card = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = path.basename(file, '.json');

    // render.html fetches ./card.json â€” give it this one
    fs.writeFileSync(CARD_FILE, JSON.stringify(card));

    await page.goto('file://' + path.join(ROOT, 'render.html'), { waitUntil: 'load' });

    // fonts must settle or the headline wraps differently than it will for a reader
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForSelector('#stage.solo', { timeout: 10000 });
    await page.waitForTimeout(400);

    const stage = await page.$('#stage');
    const dest = path.join(OUT, name + '.png');
    await stage.screenshot({ path: dest });

    const { size } = fs.statSync(dest);
    console.log(`rendered  ${name}.png  ${(size / 1024).toFixed(0)} KB  [${card.template}]`);
  }

  await browser.close();
  if (fs.existsSync(CARD_FILE)) fs.unlinkSync(CARD_FILE);
}

main().catch(err => { console.error(err); process.exit(1); });

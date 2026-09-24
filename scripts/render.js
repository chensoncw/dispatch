#!/usr/bin/env node
/**
 * render.js — turn a card record into a 1080x1080 PNG.
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

  for (const file of files) {
    const card = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = path.basename(file, '.json');

    // Every card renders twice: the square for the feed, the tall one for
    // Stories. Same record both times, so the words are only ever written once.
    // The story file is <name>-story.png and lives beside the square.
    const shapes = [
      { story: false, w: 1080, h: 1080, suffix: '' },
      { story: true,  w: 1080, h: 1920, suffix: '-story' }
    ];

    for (const shape of shapes) {
      // A fresh page per shape. Injected scripts accumulate on a reused page, so
      // this keeps each render honest about which record it drew.
      const page = await browser.newPage({
        viewport: { width: shape.w, height: shape.h },
        deviceScaleFactor: 1
      });

      // Inject the record rather than fetch it — fetch() is blocked on file://
      // in Chromium, which would silently fall back to the sample gallery.
      await page.addInitScript(([c, s]) => {
        window.__CARD__ = c;
        window.__STORY__ = s;
      }, [card, shape.story]);

      await page.goto('file://' + path.join(ROOT, 'render.html'), { waitUntil: 'load' });

      // fonts must settle or the headline wraps differently than it will for a reader
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.waitForSelector('#stage.solo', { timeout: 10000 });
      await page.waitForTimeout(400);

      const stage = await page.$('#stage');
      const dest = path.join(OUT, name + shape.suffix + '.png');
      await stage.screenshot({ path: dest });

      // Guard against a silently wrong canvas: a story that came out square
      // would publish as a Story with the top and bottom cropped off.
      const box = await stage.boundingBox();
      if (Math.round(box.width) !== shape.w || Math.round(box.height) !== shape.h) {
        throw new Error(
          `${name}${shape.suffix}: expected ${shape.w}x${shape.h}, ` +
          `stage measured ${Math.round(box.width)}x${Math.round(box.height)}`
        );
      }

      const { size } = fs.statSync(dest);
      console.log(
        `rendered  ${name}${shape.suffix}.png  ${shape.w}x${shape.h}  ` +
        `${(size / 1024).toFixed(0)} KB  [${card.template}]`
      );

      await page.close();
    }
  }

  await browser.close();
  if (fs.existsSync(CARD_FILE)) fs.unlinkSync(CARD_FILE);
}

main().catch(err => { console.error(err); process.exit(1); });

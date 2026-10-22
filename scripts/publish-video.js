#!/usr/bin/env node
/**
 * publish-video.js — post one finished video (the weekly recap) to the Facebook Page and Instagram.
 *
 *   node scripts/publish-video.js video-posts/2026-10-24-recap.json
 *
 * The video is already built and already sits at a public link in this repo (out/video/...),
 * the same file YouTube and TikTok get through Buffer. So nothing is rendered here. This only hands
 * that link to Facebook (a Page video) and Instagram (a Reel) and waits for them to take it.
 *
 * Built next to publish.js, not inside it, so the card posting that works today is never touched.
 *
 * DRY_RUN=1  print what would happen, send nothing.
 * DRY_RUN=2  smoke test: Facebook only, published:false (the video lands in the Page's video library and
 *            appears on nobody's feed). Instagram has no unpublished state, so it cannot be rehearsed.
 */

const fs = require('fs');
const path = require('path');

const API = process.env.GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.META_PAGE_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID;
const IG_ID = process.env.META_IG_USER_ID;
const REPO = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const DRY = process.env.DRY_RUN === '1';
const SMOKE = process.env.DRY_RUN === '2';
const ROOT = path.join(__dirname, '..');

async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${r.status} ${e.type || ''} (${e.code || '?'}) ${e.message || r.statusText}`);
  }
  return j;
}
const post = (url, body) => call('POST', url, body);
const get = (url) => call('GET', url);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  return !isNaN(d) && d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

/* Duplicate guard, same idea as publish.js: ask the platform, not a log. Instagram is the reliable half
 * (it can be read); Facebook is advisory because the token cannot read the Page's own posts. If Instagram
 * cannot be read, stop without posting: a late post is recoverable, a duplicate is public. */
async function instagramAlreadyHas(caption) {
  const j = await get(`https://graph.facebook.com/${API}/${IG_ID}/media?fields=caption,timestamp&limit=25&access_token=${TOKEN}`);
  return (j.data || []).some(p => p.caption === caption && isToday(p.timestamp));
}
async function facebookAlreadyHas(caption) {
  try {
    const j = await get(`https://graph.facebook.com/${API}/${PAGE_ID}/videos?fields=description,created_time&limit=25&access_token=${TOKEN}`);
    return (j.data || []).some(v => v.description === caption && isToday(v.created_time));
  } catch (e) {
    console.log(`  note      facebook check unavailable (${e.message}); Instagram will speak for both`);
    return null;
  }
}

async function publishFacebook(url, caption, published) {
  const res = await post(`https://graph.facebook.com/${API}/${PAGE_ID}/videos`, {
    file_url: url, description: caption, published, access_token: TOKEN
  });
  return res.id;
}

async function publishInstagramReel(url, caption) {
  const container = await post(`https://graph.facebook.com/${API}/${IG_ID}/media`, {
    media_type: 'REELS', video_url: url, caption, share_to_feed: true, access_token: TOKEN
  });
  // Instagram fetches and processes the video itself. Poll until it says FINISHED (up to ~8 minutes).
  let status = '';
  for (let i = 0; i < 48; i++) {
    await sleep(10000);
    const s = await get(`https://graph.facebook.com/${API}/${container.id}?fields=status_code,status&access_token=${TOKEN}`);
    status = s.status_code || '';
    console.log(`  instagram processing ${i + 1}: ${status}`);
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`instagram could not process the video (${status}): ${s.status || ''}`);
  }
  if (status !== 'FINISHED') throw new Error('instagram did not finish processing the video in time; nothing was published');
  const out = await post(`https://graph.facebook.com/${API}/${IG_ID}/media_publish`, {
    creation_id: container.id, access_token: TOKEN
  });
  return out.id;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: publish-video.js <video-posts/DATE-recap.json>'); process.exit(1); }

  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file, '.json');
  const videoPath = path.join(ROOT, rec.video);
  if (!fs.existsSync(videoPath)) { console.error(`publish-video: ${rec.video} is not in the repo`); process.exit(1); }
  if (!REPO) throw new Error('GITHUB_REPOSITORY not set');
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${rec.video}`;
  const caption = rec.caption;

  console.log(`publish-video: ${name}`);
  console.log(`  video     ${url}`);
  console.log(`  caption   ${caption.split('\n')[0]} ...`);

  if (DRY) {
    console.log('\nDRY RUN — nothing sent.\n\n--- caption ---\n' + caption + '\n---------------');
    return;
  }

  if (SMOKE) {
    console.log('\nSMOKE TEST — uploading to Facebook with published:false.');
    const id = await publishFacebook(url, caption, false);
    console.log(`SMOKE TEST PASSED — facebook accepted the video, id ${id}`);
    console.log('It sits unpublished in the Page video library and can be deleted there.');
    console.log('Instagram cannot be rehearsed: it has no unpublished state.');
    return;
  }

  // Same rule as the cards: nothing posts that Chenson has not approved. The flag lives in the record.
  if (rec.approved !== true) {
    console.error('\npublish-video: this video has not been approved. Set "approved": true in the record.\nNothing was sent.');
    process.exit(1);
  }

  let igDone;
  try { igDone = await instagramAlreadyHas(caption); }
  catch (e) {
    console.error(`\npublish-video: cannot read Instagram to check for a duplicate — ${e.message}\nStopping WITHOUT posting.`);
    process.exit(1);
  }
  const fbChecked = await facebookAlreadyHas(caption);
  const fbDone = fbChecked === null ? igDone : fbChecked;

  if (fbDone && igDone) { console.log('\npublish-video: already on Facebook and Instagram today. Nothing sent (the duplicate guard, not a failure).'); return; }

  if (fbDone) console.log('  facebook  already posted today — skipped');
  else console.log(`  facebook  posted ${await publishFacebook(url, caption, true)}`);

  if (igDone) console.log('  instagram already posted today — skipped');
  else console.log(`  instagram posted ${await publishInstagramReel(url, caption)}`);

  console.log('publish-video: done');
}

main().catch(err => { console.error('publish-video FAILED: ' + err.message); process.exit(1); });

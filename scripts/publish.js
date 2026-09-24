#!/usr/bin/env node
/**
 * publish.js — post one card to the Facebook Page and Instagram.
 *
 *   node scripts/publish.js content/2026-09-29-market.json
 *
 * Facebook is one call. Instagram is two: create a media container pointing
 * at a public image URL, then publish that container. Instagram will not
 * take raw bytes — it fetches from a URL, which is why the repo is public.
 *
 * Set DRY_RUN=1 to print what would happen and send nothing.
 */

const fs = require('fs');
const path = require('path');

const API = process.env.GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.META_PAGE_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID;
const IG_ID = process.env.META_IG_USER_ID;
const REPO = process.env.GITHUB_REPOSITORY;      // owner/name
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const DRY = process.env.DRY_RUN === '1';

// DRY_RUN=2 is the smoke test. It really does call Facebook, with published:false,
// so the photo lands in the Page's library and appears on nobody's feed. This is
// the only honest way to prove pages_manage_posts before a live post: permission
// to publish cannot be read, only exercised. Instagram has no equivalent — it has
// no unpublished state — so the smoke test covers Facebook only and says so.
const SMOKE = process.env.DRY_RUN === '2';

const ROOT = path.join(__dirname, '..');

const FIXED_TAGS = '#HenryCountyGA #SouthMetroAtlanta #KellerWilliams #Realtor';

function caption(card) {
  const tag = card.hashtag || '';
  return [
    `Comment "INFO" below and I'll send it over.`,
    ``,
    `Chenson | Keller Williams Atlanta Partners`,
    `chensoncw.kw.com`,
    ``,
    `${FIXED_TAGS} ${tag}`.trim()
  ].join('\n');
}

function imageUrl(name) {
  if (process.env.IMAGE_BASE) return `${process.env.IMAGE_BASE}/${name}.png`;
  if (!REPO) throw new Error('GITHUB_REPOSITORY not set and IMAGE_BASE not provided');
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/out/${name}.png`;
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${r.status} ${e.type || ''} (${e.code || '?'}) ${e.message || r.statusText}`);
  }
  return j;
}

async function publishFacebook(url, msg) {
  const res = await post(`https://graph.facebook.com/${API}/${PAGE_ID}/photos`, {
    url, message: msg, published: true, access_token: TOKEN
  });
  return res.post_id || res.id;
}

async function publishInstagram(url, msg) {
  const container = await post(`https://graph.facebook.com/${API}/${IG_ID}/media`, {
    image_url: url, caption: msg, access_token: TOKEN
  });
  // Instagram fetches the image itself; give it a moment before publishing.
  await new Promise(r => setTimeout(r, 4000));
  const out = await post(`https://graph.facebook.com/${API}/${IG_ID}/media_publish`, {
    creation_id: container.id, access_token: TOKEN
  });
  return out.id;
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: publish.js <content/card.json>'); process.exit(1); }

  const card = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file, '.json');
  const png = path.join(ROOT, 'out', name + '.png');

  if (!fs.existsSync(png)) {
    console.error(`publish: out/${name}.png does not exist — render before publishing`);
    process.exit(1);
  }

  const url = imageUrl(name);
  const msg = caption(card);

  console.log(`publish: ${name}`);
  console.log(`  template  ${card.template}`);
  console.log(`  image     ${url}`);
  console.log(`  caption   ${msg.split('\n')[0]} …`);

  if (DRY) {
    console.log('\nDRY RUN — nothing sent.');
    console.log('\n--- caption ---\n' + msg + '\n---------------');
    return;
  }

  if (SMOKE) {
    console.log('\nSMOKE TEST — uploading to Facebook with published:false.');
    console.log('It will not appear on the Page, in the feed, or in notifications.');
    const res = await post(`https://graph.facebook.com/${API}/${PAGE_ID}/photos`, {
      url, message: msg, published: false, access_token: TOKEN
    });
    console.log(`\nSMOKE TEST PASSED — facebook accepted the upload, id ${res.id}`);
    console.log('That is proof the token can post to the Page.');
    console.log('The photo sits unpublished in Page > Photos and can be deleted there.');
    return;
  }

  if (card.human_gate || card.template === 'market-one-figure') {
    if (process.env.APPROVED !== '1') {
      console.error('\npublish: this card is gated and APPROVED is not set.');
      console.error('The rate card never publishes unseen — it is the figure agents check most');
      console.error('and the one that goes stale fastest. Re-run with APPROVED=1 once looked at.');
      process.exit(1);
    }
  }

  const fbId = await publishFacebook(url, msg);
  console.log(`  facebook  posted ${fbId}`);

  const igId = await publishInstagram(url, msg);
  console.log(`  instagram posted ${igId}`);

  console.log('publish: done');
}

main().catch(err => {
  console.error('publish FAILED: ' + err.message);
  process.exit(1);
});

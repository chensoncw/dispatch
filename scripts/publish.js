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

// Templates that are not offering anything. A greeting and a story about the
// characters have nothing to send, so the standing call to action would be a
// sales line with no offer behind it.
//
// This shipped live on 2026-09-24: the introduction card went out reading
// 'Comment "INFO" below and I'll send it over' with nothing to send. Caught by
// Chenson on the published post, not here.
const NO_CTA = ['series', 'holiday'];

function caption(card) {
  const tag = card.hashtag || '';
  const sign = [
    `Chenson | Keller Williams Atlanta Partners`,
    `chensoncw.kw.com`,
    ``,
    `${FIXED_TAGS} ${tag}`.trim()
  ];
  // card.no_cta lets a single card drop the sales line. Used for weather alerts,
  // where "Comment INFO and I'll send it over" would be tone-deaf. 2026-10-09.
  // caption_details (2026-10-22, Chenson): the full address, times and anything extra for event cards live here, not on the card image.
  const det = (Array.isArray(card.caption_details) && card.caption_details.length) ? card.caption_details.concat(['']) : [];
  if (NO_CTA.includes(card.template) || card.no_cta === true) return det.concat(sign).join('\n');
  return det.concat([`Comment "INFO" below and I'll send it over.`, ``]).concat(sign).join('\n');
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

async function get(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${r.status} ${e.type || ''} (${e.code || '?'}) ${e.message || r.statusText}`);
  }
  return j;
}

/* ----------------------------------------------------------------
   The duplicate guard.

   On 2026-09-29 GitHub silently skipped the scheduled run entirely —
   no run, no failure, no notice — and the card had to be fired by
   hand. That is going to keep happening: Actions cron is best effort,
   and the two runs before it were four hours late rather than absent.

   So something has to re-fire a missed run. The moment anything can
   re-fire it, the same card can post twice, and a duplicate under his
   licence is worse than a late post.

   This asks the platform what is already on the feed instead of
   trusting a log. A run that succeeded but posted nothing, and a run
   that posted but reported failure, both look the same in Actions and
   opposite here.

   Each channel is checked on its own, so a run that got Facebook out
   and then broke on Instagram will finish the job on a retry rather
   than either duplicating or giving up.

   It compares the exact caption, which is built deterministically from
   the card, and only looks at today. Same words tomorrow would be a
   different post and is allowed.
   ---------------------------------------------------------------- */
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  if (isNaN(d)) return false;
  return d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
}

/* Facebook is the UNRELIABLE half of this check, and it is advisory only.
 *
 * Reading the Page's own posts needs pages_read_engagement, which this token
 * does not have. preflight.js already records that dead end twice and says in
 * so many words that a third should not be written. On 2026-09-29 this guard
 * shipped calling /{page-id}/feed anyway and killed the scheduled run — the
 * exact failure the comment was left to prevent.
 *
 * So: it is attempted, it is allowed to fail, and failure is not fatal. When
 * it cannot answer, Instagram answers for it. Returns true / false / null,
 * where null means "could not tell".
 */
async function facebookAlreadyHas(msg) {
  try {
    const j = await get(
      `https://graph.facebook.com/${API}/${PAGE_ID}/photos?type=uploaded` +
      `&fields=name,created_time&limit=25&access_token=${TOKEN}`
    );
    return (j.data || []).some(p => p.name === msg && isToday(p.created_time));
  } catch (e) {
    console.log(`  note      facebook check unavailable (${e.message})`);
    console.log('            falling back to the Instagram result — see the guard comment.');
    return null;
  }
}

/* Instagram is the RELIABLE half and the one the decision rests on.
 *
 * preflight already proves the token can read this account, and the feed post
 * to Facebook happens BEFORE the one to Instagram in the same run — so if
 * today's caption is on Instagram, Facebook necessarily went out too. That is
 * what lets Instagram stand in when the Facebook check cannot answer.
 *
 * If THIS cannot be read, the run stops without posting. A missed day is
 * recoverable — the watchdog looks at the real pages at 4pm and re-fires. A
 * duplicate under his licence is public and is not recoverable. So when the
 * guard is blind, it fails closed.
 */
async function instagramAlreadyHas(msg) {
  const j = await get(
    `https://graph.facebook.com/${API}/${IG_ID}/media` +
    `?fields=caption,timestamp&limit=25&access_token=${TOKEN}`
  );
  return (j.data || []).some(p => p.caption === msg && isToday(p.timestamp));
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

/* ----------------------------------------------------------------
   Stories.

   Same two-step shape as a feed post on Instagram, but media_type
   STORIES and no caption - a Story has nowhere to put one. The words
   are already drawn into the image, which is the point of rendering
   a separate tall version rather than letting the app crop a square.

   Facebook is different again: a Page Story wants a photo that has
   already been uploaded unpublished, then references it by id. That
   is the same published:false upload the smoke test uses.
   ---------------------------------------------------------------- */
async function publishInstagramStory(url) {
  const container = await post(`https://graph.facebook.com/${API}/${IG_ID}/media`, {
    image_url: url, media_type: 'STORIES', access_token: TOKEN
  });
  await new Promise(r => setTimeout(r, 4000));
  const out = await post(`https://graph.facebook.com/${API}/${IG_ID}/media_publish`, {
    creation_id: container.id, access_token: TOKEN
  });
  return out.id;
}

async function publishFacebookStory(url) {
  const photo = await post(`https://graph.facebook.com/${API}/${PAGE_ID}/photos`, {
    url, published: false, access_token: TOKEN
  });
  const out = await post(`https://graph.facebook.com/${API}/${PAGE_ID}/photo_stories`, {
    photo_id: photo.id, access_token: TOKEN
  });
  return out.post_id || out.id;
}

/* ----------------------------------------------------------------
   Platforms (2026-11-14, Chenson: "fb gets card only, insta gets video only, not both").
   A card may carry "platforms": ["facebook"]. Without the field a card goes to Facebook and Instagram, exactly as before.

   A Facebook-only card has no Instagram post to ask whether it is already up, and Facebook cannot be read back with this
   token, so the duplicate guard becomes a CLAIM: before posting, this writes posted/<card>.facebook.json to the repo
   (the contents API refuses a second write of the same path). A run that finds the claim stops. If the post then FAILS, the
   claim is deleted so a later run can try again. Needs GH_TOKEN (the workflow's own token, contents: write).
   ---------------------------------------------------------------- */
async function ghContents(method, p, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${p}${method === 'GET' ? '?ref=' + BRANCH : ''}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dispatch-publish', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
async function claimFacebook(name) {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is missing, so a duplicate cannot be guarded against; stopping without posting');
  const p = `posted/${name}.facebook.json`;
  const g = await ghContents('GET', p);
  if (g.status === 200) return { claimed: false };
  const put = await ghContents('PUT', p, { message: `claim ${name} for facebook`, content: Buffer.from(JSON.stringify({ card: name, platform: 'facebook', claimedAt: new Date().toISOString() })).toString('base64'), branch: BRANCH });
  if (put.status === 201 || put.status === 200) return { claimed: true, path: p, sha: put.json.content.sha };
  if (put.status === 422 || put.status === 409) return { claimed: false };
  throw new Error(`could not claim ${name} on GitHub (${put.status} ${put.json.message || ''}); stopping without posting`);
}
async function releaseFacebookClaim(c) {
  try { await ghContents('DELETE', c.path, { message: `release claim for ${c.path} (post failed)`, sha: c.sha, branch: BRANCH }); } catch (e) { console.warn(`  note      could not release the claim: ${e.message}`); }
}
async function facebookOnly(name, url, msg) {
  const c = await claimFacebook(name);
  if (!c.claimed) { console.log('\npublish: this card is already claimed for Facebook (posted today or earlier). Nothing sent. This is the duplicate guard, not a failure.'); return; }
  try {
    const fbId = await publishFacebook(url, msg);
    console.log(`  facebook  posted ${fbId}`);
  } catch (e) { await releaseFacebookClaim(c); throw e; }
  const storyName = name + '-story';
  if (!fs.existsSync(path.join(ROOT, 'out', storyName + '.png'))) { console.log('  stories   skipped — no out/' + storyName + '.png'); }
  else {
    try { console.log(`  fb story  posted ${await publishFacebookStory(imageUrl(storyName))}`); }
    catch (e) { console.warn(`  fb story  FAILED — ${e.message}\n            the feed post above is unaffected and is live.`); }
  }
  console.log('  instagram not requested for this card (Facebook only)');
  console.log('publish: done');
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: publish.js <content/card.json>'); process.exit(1); }

  const card = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file, '.json');
  const platforms = (Array.isArray(card.platforms) && card.platforms.length) ? card.platforms.map(s => String(s).toLowerCase()) : ['facebook', 'instagram'];
  const png = path.join(ROOT, 'out', name + '.png');

  if (!fs.existsSync(png)) {
    console.error(`publish: out/${name}.png does not exist — render before publishing`);
    process.exit(1);
  }

  const url = imageUrl(name);
  const msg = caption(card);

  console.log(`publish: ${name}`);
  console.log(`  template  ${card.template}`);
  console.log(`  platforms ${platforms.join(' + ')}`);
  console.log(`  image     ${url}`);
  console.log(`  caption   ${msg.split('\n')[0]} …`);

  if (process.env.DRY_RUN === '3') {
    // claim test: proves the workflow's token can write and delete a claim file, posts nothing anywhere
    const c = await claimFacebook('_claim-test');
    console.log(`claim test: ${c.claimed ? 'wrote the claim file' : 'a claim file already existed'}`);
    if (c.claimed) { await ghContents('DELETE', c.path, { message: 'claim test cleanup', sha: c.sha, branch: BRANCH }); console.log('claim test: deleted it again. PASSED. Nothing was posted.'); }
    return;
  }

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

    // The story image gets the same treatment, one step short of publishing.
    // Uploading it unpublished proves the file is reachable and that Facebook
    // accepts it — which is the half of a Page Story that can be tested without
    // one actually appearing. Instagram has no unpublished state at all, so its
    // Story path cannot be rehearsed; the first real one is the first one.
    const sName = name + '-story';
    if (!fs.existsSync(path.join(ROOT, 'out', sName + '.png'))) {
      console.log(`\nstory: no out/${sName}.png to test.`);
    } else {
      const sUrl = imageUrl(sName);
      console.log(`\nstory image  ${sUrl}`);
      try {
        const s = await post(`https://graph.facebook.com/${API}/${PAGE_ID}/photos`, {
          url: sUrl, published: false, access_token: TOKEN
        });
        console.log(`story: facebook accepted the tall image, id ${s.id}`);
        console.log('story: it was NOT posted as a Story — that cannot be rehearsed.');
      } catch (e) {
        console.error(`story: FAILED — ${e.message}`);
        process.exit(1);
      }
    }
    return;
  }

  // Nothing publishes that Chenson has not seen rendered and approved.
  //
  // This used to gate only the rate card. It now gates everything, at his
  // instruction on 2026-09-24: the card carries his licence, his name and his
  // face to the public, so automation does not get to decide what goes out
  // under it. It may fetch, render and post — it may not approve.
  //
  // The flag lives in the content file rather than in an environment variable
  // on purpose. A workflow input approves whatever happens to run; `approved`
  // in the JSON approves the exact card he looked at. Change a figure after
  // approval and the field has to be set again, which is the intended friction.
  if (card.approved !== true) {
    console.error('\npublish: this card has not been approved.');
    console.error('Every card is shown to Chenson rendered, and approved by him, before it posts.');
    console.error('Set "approved": true in the content file once he has seen the image.');
    console.error('Nothing was sent.');
    process.exit(1);
  }

  if (card.human_gate || card.template === 'market-one-figure') {
    if (process.env.APPROVED !== '1') {
      console.error('\npublish: the rate card needs APPROVED=1 as well as "approved": true.');
      console.error('It is the figure agents check most and the one that goes stale fastest,');
      console.error('so it is confirmed at the moment of sending, not only at review time.');
      process.exit(1);
    }
  }

  // A Facebook-only card: no Instagram post, no Instagram story (see the Platforms note above).
  if (!platforms.includes('instagram')) {
    if (!platforms.includes('facebook')) { console.log('publish: this card names no platform to post to. Nothing sent.'); return; }
    await facebookOnly(name, url, msg);
    return;
  }

  // Ask the platform, not the log, whether this card is already out.
  // See the duplicate guard above for why this exists.
  let igDone;
  try {
    igDone = await instagramAlreadyHas(msg);
  } catch (e) {
    console.error(`\npublish: cannot read Instagram to check for a duplicate — ${e.message}`);
    console.error('Stopping WITHOUT posting. Posting blind risks a duplicate under his licence,');
    console.error('and a missed day is recoverable: the 4pm watchdog checks the real pages.');
    process.exit(1);
  }

  // null means the Facebook check could not answer; Instagram then speaks for
  // both, because Facebook is posted first in this same run.
  const fbChecked = await facebookAlreadyHas(msg);
  const fbDone = fbChecked === null ? igDone : fbChecked;

  if (fbDone && igDone) {
    console.log('\npublish: this card is ALREADY on Facebook and Instagram today.');
    console.log('Nothing sent. This is the duplicate guard doing its job, not a failure.');
    return;
  }

  if (fbDone) {
    console.log('  facebook  already posted today — skipped');
  } else {
    const fbId = await publishFacebook(url, msg);
    console.log(`  facebook  posted ${fbId}`);
  }

  if (igDone) {
    console.log('  instagram already posted today — skipped');
  } else {
    const igId = await publishInstagram(url, msg);
    console.log(`  instagram posted ${igId}`);
  }

  // --- stories -------------------------------------------------------------
  //
  // The feed post is the deliverable. A Story is a bonus reach on the same
  // words, and it is gone in 24 hours either way. So a Story failure NEVER
  // fails this run: by the time we get here the feed post is already public
  // and cannot be taken back, and exiting non-zero would light up the "it
  // broke" alert about something that did not break.
  //
  // It is reported loudly instead, and it publishes only if the tall image
  // was actually rendered. No story file means this card was rendered before
  // stories existed, which is not an error.
  const storyName = name + '-story';
  const storyPng = path.join(ROOT, 'out', storyName + '.png');

  if (!fs.existsSync(storyPng)) {
    console.log('  stories   skipped — no out/' + storyName + '.png');
  } else {
    const storyUrl = imageUrl(storyName);
    console.log(`  story img ${storyUrl}`);

    try {
      const igs = await publishInstagramStory(storyUrl);
      console.log(`  ig story  posted ${igs}`);
    } catch (e) {
      console.warn(`  ig story  FAILED — ${e.message}`);
      console.warn('            the feed post above is unaffected and is live.');
    }

    try {
      const fbs = await publishFacebookStory(storyUrl);
      console.log(`  fb story  posted ${fbs}`);
    } catch (e) {
      console.warn(`  fb story  FAILED — ${e.message}`);
      console.warn('            the feed post above is unaffected and is live.');
    }
  }

  console.log('publish: done');
}

main().catch(err => {
  console.error('publish FAILED: ' + err.message);
  process.exit(1);
});

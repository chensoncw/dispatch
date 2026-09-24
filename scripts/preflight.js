#!/usr/bin/env node
/**
 * preflight.js — check the token before anything tries to publish.
 *
 * The token is the real failure mode, not the API. Change a Facebook
 * password or revoke a permission and it invalidates — and without this
 * check the post simply does not happen and nobody finds out until
 * somebody asks why the account went quiet.
 *
 * Exits non-zero so the workflow stops and alerts rather than failing silently.
 */

const API = process.env.GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.META_PAGE_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID;
const IG_ID = process.env.META_IG_USER_ID;

async function get(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${r.status} ${e.type || ''} ${e.message || r.statusText}`);
  }
  return j;
}

async function main() {
  const missing = [];
  if (!TOKEN) missing.push('META_PAGE_TOKEN');
  if (!PAGE_ID) missing.push('META_PAGE_ID');
  if (!IG_ID) missing.push('META_IG_USER_ID');
  if (missing.length) {
    console.error('preflight: missing repository secrets: ' + missing.join(', '));
    console.error('Add them under Settings > Secrets and variables > Actions.');
    process.exit(1);
  }

  // 1. is the token alive, and whose is it
  const me = await get(`https://graph.facebook.com/${API}/me?fields=id,name&access_token=${TOKEN}`);
  console.log(`preflight: token valid — ${me.name} (${me.id})`);

  if (me.id !== PAGE_ID) {
    console.warn(`preflight: WARNING token belongs to ${me.id} but META_PAGE_ID is ${PAGE_ID}`);
  }

  // 2. can it still read the Page's own feed
  //
  // There is no read-only way to prove pages_manage_posts — the only proof of
  // permission to post is a post. So this reads the feed instead, which needs
  // pages_read_engagement. The two are granted together and revoked together,
  // so a feed read that works is good evidence the posting grant survived too.
  //
  // (/me/permissions used to live here. It is a User node field: against a Page
  // token it fails every single run, which is how it trained us to skim past
  // preflight output. A check that always warns is worse than no check.)
  await get(`https://graph.facebook.com/${API}/${PAGE_ID}/feed?limit=1&access_token=${TOKEN}`);
  console.log('preflight: page feed readable — read/engagement grant intact');

  // 3. can we see the Instagram account
  const ig = await get(`https://graph.facebook.com/${API}/${IG_ID}?fields=username&access_token=${TOKEN}`);
  console.log(`preflight: instagram reachable — @${ig.username}`);

  console.log('preflight: OK');
}

main().catch(err => {
  console.error('preflight FAILED: ' + err.message);
  console.error('\nMost likely the token expired or was invalidated. Re-run the token handshake:');
  console.error('short-lived user token -> long-lived user token -> Page token, then update the secret.');
  process.exit(1);
});

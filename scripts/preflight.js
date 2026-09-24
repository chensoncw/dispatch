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

  // 2. nothing here checks whether the token may post.
  //
  // Two attempts lived here and both were wrong, in the same way and worth
  // recording so a third is not written:
  //
  //   /me/permissions   — a User node field. Against a Page token it fails on
  //                       every run, so it warned on every run.
  //   /{page-id}/feed   — needs pages_read_engagement, which reads like a
  //                       reasonable proxy for pages_manage_posts. It is not.
  //                       On 2026-09-24 this warned that the token could not
  //                       post, while DRY_RUN=2 uploaded to that same Page with
  //                       that same token and Facebook accepted it. The proxy
  //                       was wrong, not the token.
  //
  // The second one cost an afternoon of reissuing perfectly good tokens. A
  // check that can fail while the real thing works does more damage than no
  // check, because it sends you off fixing something that was never broken.
  //
  // Permission to publish cannot be read. It can only be exercised. That is
  // what DRY_RUN=2 in publish.js is for: it posts with published:false, which
  // reaches no feed and no follower, and either succeeds or names the real
  // error. Run that after any token change — it is the only honest answer.

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

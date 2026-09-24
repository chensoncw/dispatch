#!/usr/bin/env node
/**
 * preflight.js â€” check the token before anything tries to publish.
 *
 * The token is the real failure mode, not the API. Change a Facebook
 * password or revoke a permission and it invalidates â€” and without this
 * check the post simply does not happen and nobody finds out until
 * somebody asks why the account went quiet.
 *
 * Exits non-zero so the workflow stops and alerts rather than failing silently.
 */

const API = process.env.GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.META_PAGE_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID;
const IG_ID = process.env.META_IG_USER_ID;

const NEEDED = ['pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'];

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
  console.log(`preflight: token valid â€” ${me.name} (${me.id})`);

  if (me.id !== PAGE_ID) {
    console.warn(`preflight: WARNING token belongs to ${me.id} but META_PAGE_ID is ${PAGE_ID}`);
  }

  // 2. does it still hold the permissions we publish with
  try {
    const perms = await get(`https://graph.facebook.com/${API}/me/permissions?access_token=${TOKEN}`);
    const granted = (perms.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    const lost = NEEDED.filter(n => !granted.includes(n));
    if (lost.length) {
      console.warn('preflight: WARNING these permissions are not reported as granted: ' + lost.join(', '));
      console.warn('A Page token often does not list them here. Treat as a hint, not a verdict.');
    } else {
      console.log('preflight: all publishing permissions present');
    }
  } catch (e) {
    console.warn('preflight: could not read permissions (' + e.message + ') â€” continuing');
  }

  // 3. can we see the Instagram account
  const ig = await get(`https://graph.facebook.com/${API}/${IG_ID}?fields=username&access_token=${TOKEN}`);
  console.log(`preflight: instagram reachable â€” @${ig.username}`);

  console.log('preflight: OK');
}

main().catch(err => {
  console.error('preflight FAILED: ' + err.message);
  console.error('\nMost likely the token expired or was invalidated. Re-run the token handshake:');
  console.error('short-lived user token -> long-lived user token -> Page token, then update the secret.');
  process.exit(1);
});

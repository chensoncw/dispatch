#!/usr/bin/env node
/**
 * post-check.js — the watchdog, with no computer and no browser involved.
 *
 * Asks Instagram's own media list (through the same Meta token the publisher uses) whether today's post is up.
 * If today has a card (content/TODAY-*.json, approved) and no Instagram post from today carries the Keller Williams
 * signature, this EXITS 1 with a plain message. GitHub emails the repo owner when a workflow fails, so that email is the alert.
 * On a Saturday with a video record (video-posts/TODAY-*.json, approved) it checks the same way for the recap Reel.
 *
 * It never posts anything. The publish workflow already runs several times a day and has a duplicate guard, so a late
 * or skipped run is repaired by the next run; this only says so out loud if the day ends up empty.
 */
const fs = require('fs');
const path = require('path');

const API = process.env.GRAPH_VERSION || 'v21.0';
const TOKEN = process.env.META_PAGE_TOKEN;
const IG_ID = process.env.META_IG_USER_ID;
const ROOT = path.join(__dirname, '..');
// "today" is the Eastern date: GitHub can start this run after midnight UTC, which is still evening here
const etDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const today = etDay(Date.now());

function pick(dir, approvedOnly) {
  const d = path.join(ROOT, dir);
  if (!fs.existsSync(d)) return null;
  const f = fs.readdirSync(d).filter(n => n.startsWith(today + '-') && n.endsWith('.json')).sort()[0];
  if (!f) return null;
  const rec = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  if (approvedOnly && rec.approved !== true) return { name: f, approved: false };
  return { name: f, approved: true };
}

async function main() {
  const card = pick('content', true);
  const video = pick('video-posts', true);
  const want = [];
  if (card && card.approved) want.push(`today's card (${card.name})`);
  if (video && video.approved) want.push(`today's recap video (${video.name})`);
  if (card && !card.approved) console.log(`note: ${card.name} is not approved, so nothing was due.`);
  if (!want.length) { console.log(`post-check: nothing due on ${today}. OK.`); return; }

  const r = await fetch(`https://graph.facebook.com/${API}/${IG_ID}/media?fields=caption,timestamp,media_type&limit=25&access_token=${TOKEN}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { console.error(`post-check: could not read Instagram (${(j.error || {}).message || r.status}). Cannot tell.`); process.exit(1); }
  const todays = (j.data || []).filter(p => p.timestamp && etDay(p.timestamp) === today && /Keller Williams Atlanta Partners/.test(p.caption || ''));
  const reels = todays.filter(p => p.media_type === 'VIDEO');
  const images = todays.filter(p => p.media_type !== 'VIDEO');

  let bad = [];
  if (card && card.approved && images.length === 0) bad.push(`today's card (${card.name}) is NOT on Instagram`);
  if (video && video.approved && reels.length === 0) bad.push(`today's recap video (${video.name}) is NOT on Instagram`);
  if (bad.length) {
    console.error('post-check PROBLEM: ' + bad.join('; ') + '. The publish workflow runs again later today and has a duplicate guard; re-run "Publish" / "Publish Video" by hand if this stays empty.');
    process.exit(1);
  }
  console.log(`post-check: ${want.join(' and ')} is on Instagram. OK.`);
}
main().catch(e => { console.error('post-check FAILED: ' + e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * bank.js — the data bank.
 *
 *   node scripts/bank.js build          rebuild bank.json from every content file
 *   node scripts/bank.js check <topic>  what has already been said on a topic
 *   node scripts/bank.js due            topics whose interval has expired
 *
 * WHAT IT IS FOR
 *
 * The same subjects come round forever: property tax every autumn, homestead
 * every spring, the market every week. The risk is saying the same thing twice
 * — and the gap that matters is months, not years. A point made in October and
 * repeated in December is the failure mode, not April to April.
 *
 * So this records what was said and when, filed by year and month, and is
 * CHECKED WHILE A CARD IS BEING WRITTEN, not after. Before writing on a topic,
 * look it up here and confirm the angle has not run inside its interval. That
 * check is part of writing a card, the same way sourcing is.
 *
 * It is also the reference for the rewrite: the old entry is the starting
 * material for saying the same thing a different way.
 *
 * WHY IT IS DERIVED, NOT KEPT BY HAND
 *
 * Every published card stays in content/ forever, so the history already
 * exists — it is just not readable. This builds the readable index FROM those
 * files, which means it cannot drift out of step with what actually ran. A
 * hand-maintained list would be wrong within a month.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTENT = path.join(ROOT, 'content');
const BANK = path.join(ROOT, 'bank.json');

// How long before the same angle may run again. Months.
// Chenson's guide: genuinely repeatable material waits about two years; the
// thing that must never happen is the same point twice in one season.
const INTERVAL = {
  market: 1,       // weekly by nature - only the angle repeats, not the figures
  teaching: 24,
  community: 1,
  home: 12,
  calendar: 12,    // holidays return annually and are meant to
  series: 6,
  _default: 12
};

const stop = new Set(('a an and are as at be but by for from had has have how in into is it its of on '+
  'or our out so than that the their them then there these they this to too was what when where which '+
  'who will with would you your i it\'s').split(' '));

/** The sentences a card actually says, ignoring furniture. */
function spoken(card) {
  const out = [];
  const take = v => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(take);
    else if (v && typeof v === 'object') Object.values(v).forEach(take);
  };
  for (const [k, v] of Object.entries(card)) {
    if (k.startsWith('_')) continue;
    if (['source', 'disclaimer', 'hashtag', 'template', 'skin', 'theme',
         'titan_pose', 'echo_pose', 'approved', 'eyebrow'].includes(k)) continue;
    take(v);
  }
  return out;
}

/** Rough subject fingerprint, so two cards on the same subject collide. */
function keywords(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w));
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0]);
}

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function load() {
  if (!fs.existsSync(CONTENT)) return [];
  return fs.readdirSync(CONTENT)
    .filter(f => f.endsWith('.json') && /^\d{4}-\d{2}-\d{2}-/.test(f))
    .map(f => {
      const card = JSON.parse(fs.readFileSync(path.join(CONTENT, f), 'utf8'));
      const date = f.slice(0, 10);
      const slug = f.slice(11, -5);
      const said = spoken(card);
      return {
        date,
        year: date.slice(0, 4),
        month: date.slice(0, 7),
        topic: slug,
        template: card.template,
        slot: (card.template || '').split('-')[0],
        headline: (card.headline || '').replace(/\n/g, ' '),
        said,
        keywords: keywords(said.join(' ')),
        source: card.source || null
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function build() {
  const entries = load();
  const byTopic = {};
  for (const e of entries) (byTopic[e.topic] = byTopic[e.topic] || []).push(e);

  const bank = {
    _about: 'What has already been said, by year and month. Built from content/ by scripts/bank.js — never edited by hand, or it drifts from what actually ran.',
    _built: new Date().toISOString().slice(0, 10),
    _how_to_use: 'Before writing a card, run: node scripts/bank.js check <topic>. If the angle ran inside its interval, write a different one.',
    _intervals_months: INTERVAL,
    count: entries.length,
    by_year: {},
    by_topic: byTopic,
    entries
  };
  for (const e of entries) {
    (bank.by_year[e.year] = bank.by_year[e.year] || {});
    (bank.by_year[e.year][e.month] = bank.by_year[e.year][e.month] || []).push({
      date: e.date, topic: e.topic, headline: e.headline
    });
  }
  fs.writeFileSync(BANK, JSON.stringify(bank, null, 2) + '\n', 'utf8');
  console.log(`bank: ${entries.length} cards indexed across ${Object.keys(bank.by_year).length} year(s)`);
  for (const y of Object.keys(bank.by_year).sort()) {
    for (const m of Object.keys(bank.by_year[y]).sort()) {
      console.log(`  ${m}  ${bank.by_year[y][m].length} card(s)`);
    }
  }
}

function check(topic) {
  const entries = load();
  const now = new Date();
  const q = topic.toLowerCase();

  // Match on the topic slug, then widen to keyword overlap so a differently
  // named card about the same subject still surfaces.
  const direct = entries.filter(e => e.topic.includes(q));
  const related = entries.filter(e => !direct.includes(e) && e.keywords.includes(q));
  const hits = direct.concat(related);

  if (!hits.length) {
    console.log(`bank: nothing on "${topic}" yet — anything you write is new.`);
    return;
  }

  console.log(`bank: ${hits.length} card(s) touching "${topic}"\n`);
  for (const e of hits) {
    const age = monthsBetween(new Date(e.date), now);
    const wait = INTERVAL[e.slot] ?? INTERVAL._default;
    const clear = age >= wait;
    console.log(`  ${e.date}  [${e.template}]  ${e.headline}`);
    e.said.forEach(s => console.log(`      ${s.length > 108 ? s.slice(0, 105) + '…' : s}`));
    console.log(`      ${age} month(s) ago · interval ${wait} · ` +
                (clear ? 'CLEAR to run this angle again' : 'TOO SOON — use a different angle'));
    if (e.source) console.log(`      was sourced to ${e.source}`);
    console.log('');
  }
  console.log('Use the lines above as the starting material, not as a template to copy.');
}

function due() {
  const entries = load();
  const now = new Date();
  const latest = {};
  for (const e of entries) {
    if (!latest[e.topic] || e.date > latest[e.topic].date) latest[e.topic] = e;
  }
  const rows = Object.values(latest).map(e => {
    const age = monthsBetween(new Date(e.date), now);
    const wait = INTERVAL[e.slot] ?? INTERVAL._default;
    return { ...e, age, wait, clear: age >= wait };
  }).sort((a, b) => b.age - a.age);

  console.log('bank: topics and whether their angle may run again\n');
  for (const r of rows) {
    console.log(`  ${r.clear ? 'CLEAR   ' : 'too soon'}  ${r.topic.padEnd(22)} ` +
                `last ${r.date} (${r.age}m ago, interval ${r.wait}m)`);
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'build') build();
else if (cmd === 'check' && arg) check(arg);
else if (cmd === 'due') due();
else {
  console.log('usage:');
  console.log('  node scripts/bank.js build          rebuild bank.json from content/');
  console.log('  node scripts/bank.js check <topic>  what has already been said');
  console.log('  node scripts/bank.js due            which topics are clear to run again');
  process.exit(1);
}

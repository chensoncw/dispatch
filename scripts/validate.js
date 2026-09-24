#!/usr/bin/env node
/**
 * validate.js — gate every card before it renders.
 *
 *   node scripts/validate.js content/2026-09-29-market.json
 *   node scripts/validate.js content/*.json
 *
 * Exits non-zero on any failure, so the workflow stops rather than
 * publishing something wrong. Once this runs unattended nobody eyeballs
 * the card, so a silent overflow would push the source line off and ship.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema.json'), 'utf8'));

const PROFESSIONALS = [
  'plumber', 'electrician', 'inspector', 'professional', 'lender',
  'contractor', 'fire department', 'licensed', 'attorney', 'assessor',
  'tax commissioner'
];
const FORECAST = [
  'will be', 'expect', 'heading', 'on track to', 'poised', 'forecast',
  'predict', 'next month will', 'by the end of the year', 'going to rise',
  'going to fall', 'should climb', 'should drop'
];
// Bodies whose published projections may be reported as theirs. Naming one near
// a forecast phrase is what turns a prediction into a quotation. Keep this list
// to institutions that publish projections on the record — not commentators.
const ATTRIBUTION = [
  'federal reserve', 'the fed', "fed's", 'fomc', 'freddie mac', 'fannie mae',
  'mortgage bankers association', 'mba', 'national association of realtors',
  'nar', 'census bureau', 'bureau of labor statistics', 'projections', 'projects',
  'projected', 'according to', 'forecasts that'
];
const QUANTIFIERS = ['most', 'many', 'usually', 'typically', 'rarely', 'often', 'generally'];
const INSTRUCTIONS = [
  'you should', 'you need to', 'you must', 'you have to',
  "i shouldn't", 'i should not', "don't forget to", 'make sure you'
];

let failures = [];
let warnings = [];

function fail(file, rule, msg) { failures.push(`${file}\n    [${rule}] ${msg}`); }
function warn(file, rule, msg) { warnings.push(`${file}\n    [${rule}] ${msg}`); }

/** Every string in the record, flattened, so text rules can sweep all of it. */
function allText(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => allText(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => allText(x, out));
  return out;
}

/** Strip the *gold* / **bold** markers before counting characters. */
function plain(s) {
  return String(s == null ? '' : s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

function len(s) { return plain(s).replace(/<[^>]+>/g, '').replace(/\n/g, ' ').length; }

function findPhrase(text, list) {
  const low = text.toLowerCase();
  return list.find(p => low.includes(p));
}

function findWord(text, list) {
  const low = ' ' + text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ') + ' ';
  return list.find(w => low.includes(' ' + w + ' '));
}

function checkLengths(file, card, tpl) {
  for (const [name, spec] of Object.entries(tpl.fields || {})) {
    const val = card[name];

    if (spec.required && (val == null || val === '')) {
      fail(file, 'required', `"${name}" is required and missing`);
      continue;
    }
    if (val == null) continue;
    if (spec.fixed) continue;

    if (typeof spec.max === 'number' && typeof val === 'string') {
      const n = len(val);
      if (n > spec.max) fail(file, 'max_length', `"${name}" is ${n} chars, limit ${spec.max}`);
    }

    if (Array.isArray(spec.count) && Array.isArray(val)) {
      const [lo, hi] = spec.count;
      if (val.length < lo || val.length > hi) {
        fail(file, 'count', `"${name}" has ${val.length} items, allowed ${lo}–${hi}`);
      }
    }
    if (typeof spec.count === 'number' && Array.isArray(val) && val.length !== spec.count) {
      fail(file, 'count', `"${name}" has ${val.length} items, must be exactly ${spec.count}`);
    }

    // rows/items with their own per-part limits
    if (Array.isArray(val) && typeof spec.max === 'number') {
      val.forEach((row, i) => {
        const s = typeof row === 'string' ? row : (row.detail || '');
        if (len(s) > spec.max) {
          fail(file, 'max_length', `"${name}[${i}]" is ${len(s)} chars, limit ${spec.max}`);
        }
      });
    }
  }
}

function checkRules(file, card, tpl, tplName) {
  const text = allText(card).join(' \u0001 ');
  // A claimless card states nothing checkable — a greeting, or a story about
  // the characters — so there is nothing to cite and a source would be
  // decoration. Driven by the template's own no_source flag rather than a
  // hardcoded name, so it covers holiday and series alike.
  const claimless = tpl.no_source === true;

  // --- sourced ---
  if (!claimless) {
    if (!card.source) fail(file, 'sourced', 'source is required on every card that states something');
    if (!card.disclaimer) fail(file, 'sourced', 'disclaimer is required on every card that states something');
  }
  if (claimless && (card.source || card.disclaimer)) {
    fail(file, 'sourced',
      `a ${tplName} card carries no source or disclaimer — ` +
      'the moment it states something checkable it is a different template and the sourcing rules apply');
  }

  // --- dated figures ---
  if (tplName.startsWith('market-')) {
    if (tplName === 'market-two-figures' && !card.asof) {
      fail(file, 'dated_figures', 'market cards must carry "asof" — the day the figure was true');
    }
    const src = card.source || '';
    if (!/\d{4}|week ending|week of/i.test(src)) {
      fail(file, 'dated_figures', 'source must name a date or a week — a figure without one reads as current');
    }
  }

  // --- no forecast ---
  // A disclaimer legitimately says "not a prediction" — that is the opposite of
  // forecasting, so the disclaimer is excluded. Negated forms are ignored
  // everywhere else too: "not a forecast" is a denial, not a forecast.
  //
  // Attributed projections are allowed, at Chenson's instruction on 2026-09-24.
  // What the Fed or Fannie Mae projects is a fact about what they said; whether
  // it comes true is, in his words, a whole different matter. Reporting it is
  // reporting. Making one is not.
  //
  //   allowed  — "The Fed's September projections put it at X by year end."
  //   blocked  — "Rates are heading down."
  //
  // The test is attribution: a named body within 60 characters before the
  // phrase. A word list cannot tell a careful sentence from a careless one, so
  // this narrows what reaches him — it does not replace him reading the card.
  const { disclaimer: _d, ...rest } = card;
  const forecastText = allText(rest).join(' \u0001 ').toLowerCase();
  const fc = FORECAST.find(p => {
    let i = forecastText.indexOf(p);
    while (i >= 0) {
      const before = forecastText.slice(Math.max(0, i - 60), i);
      const negated = /\b(not|never|no|isn't|is not|aren't|nobody knows)\s+(a\s+|an\s+)?$/
        .test(forecastText.slice(Math.max(0, i - 16), i));
      const attributed = ATTRIBUTION.some(a => before.includes(a));
      if (!negated && !attributed) return true;
      i = forecastText.indexOf(p, i + 1);
    }
    return false;
  });
  if (fc) {
    fail(file, 'no_forecast',
      `forecasting language with nobody's name on it: "${fc}" — ` +
      `attribute it to a named body, or drop it`);
  }

  // --- the pose has to agree with the card ---
  //
  // The art carries tone whether or not it was chosen for tone, and the picture
  // is what people see before they read a word. Echo delighted with his fists up
  // on a card about house fire deaths contradicts the sentence under it.
  //
  // Only the two checkable mistakes are caught here. Whether a pose suits the
  // subject is a judgement, and stays Chenson's on the rendered card.
  const SOBER = ['home-safety'];
  const BUST = 'echo-alt';
  // titan-alt was here too until its crown was repaired on 2026-09-24. echo-alt
  // stays, but it is not damaged - it is a bust, which is correct in the echo
  // band and wrong only where the figure is the subject.
  const CROPPED = { 'echo-alt': 'a bust that ends mid-chest' };

  if (SOBER.includes(card.template) && card.echo_pose === 'echo-surprised') {
    fail(file, 'pose_matches_register',
      `${card.template} is the sober register and echo-surprised is delighted — ` +
      `use ${BUST} in the band, or a neutral standing pose`);
  }

  // Poses are small in the echo band, where a bust is exactly right. On a
  // holiday card they are the subject at full size, so a crop reads as a
  // missing body.
  //
  // A warning, not a failure. Neither pose is retired — echo-alt is a
  // legitimate bust and titan-alt is usable until it is re-cut. Blocking them
  // outright would take working art out of service over a judgement that
  // belongs to Chenson looking at the rendered card.
  if (card.template === 'holiday') {
    for (const f of ['titan_pose', 'echo_pose']) {
      if (CROPPED[card[f]]) {
        warn(file, 'pose_full_body',
          `${card[f]} is ${CROPPED[card[f]]} and a holiday card shows the figure at full size — ` +
          `check the render before approving`);
      }
    }
  }

  // --- bare quantifiers ---
  const q = findWord(text, QUANTIFIERS);
  if (q && !card.source) {
    fail(file, 'no_bare_quantifiers', `"${q}" is a statistic wearing a word, and nothing sources it`);
  } else if (q) {
    warn(file, 'no_bare_quantifiers',
      `"${q}" is used — confirm the source actually supports it, or drop the word`);
  }

  // --- echo ---
  if (card.echo_line) {
    const e = card.echo_line;
    const ins = findPhrase(e, INSTRUCTIONS);
    if (ins) fail(file, 'echo_first_person', `echo_line instructs the reader: "${ins}"`);
    if (plain(e).trim().endsWith('?')) {
      fail(file, 'echo_lands', 'echo_line ends on a question — the question is the opening beat, not the close');
    }
  }

  // --- titan names echo ---
  const titanFields = [card.titan_line, card.turn_1, card.correction].filter(Boolean).join(' ');
  if (titanFields && !/\bEcho\b/.test(titanFields)) {
    warn(file, 'titan_names_echo', 'Titan does not say "Echo" — it should read as a conversation, not two captions');
  }

  // --- home rows name a professional ---
  if (tplName === 'home-walkround' || tplName === 'home-safety') {
    (card.rows || []).forEach((row, i) => {
      const s = typeof row === 'string' ? row : (row.detail || '');
      if (!findPhrase(s, PROFESSIONALS)) {
        fail(file, 'home_rows_name_a_pro',
          `rows[${i}] names no professional — the card says what to look at, never what to do`);
      }
    });
  }

  // --- no prices on work ---
  const priceHit = /\$\s?\d[\d,]*(\.\d+)?/.exec(text);
  if (priceHit && !tplName.startsWith('market-')) {
    warn(file, 'no_prices',
      `contains "${priceHit[0]}" — dollar figures are only for sourced market data, never for repairs or services`);
  }

  // --- event still ahead ---
  const needsDate = ['community-diary', 'community-spotlight', 'deadline-countdown', 'holiday'];
  if (needsDate.includes(tplName)) {
    if (!card.event_date) {
      fail(file, 'event_still_ahead', 'event_date is required on this template');
    } else {
      const ev = new Date(card.event_date + 'T23:59:59');
      const pub = card.publish_at ? new Date(card.publish_at) : new Date();
      if (isNaN(ev)) fail(file, 'event_still_ahead', `event_date "${card.event_date}" is not a date`);
      else if (ev < pub) {
        fail(file, 'event_still_ahead',
          `event_date ${card.event_date} is before publish time — that is the past in a future tense`);
      }
    }
  }

  // --- every tile figure appears in a sentence ---
  if (tplName === 'market-two-figures') {
    const sentence = plain(card.titan_line || '');
    [card.stat_a, card.stat_b].forEach((s, i) => {
      if (s && s.value && !sentence.includes(plain(s.value))) {
        fail(file, 'tile_needs_a_sentence',
          `stat_${i ? 'b' : 'a'} value "${s.value}" never appears in titan_line — a bare tile reads as a random number`);
      }
    });
  }
  if (tplName === 'market-one-figure') {
    const shown = plain(card.big_number || '');
    const anywhere = plain([card.titan_line, card.big_caption].join(' '));
    if (shown && !anywhere.includes(shown)) {
      warn(file, 'tile_needs_a_sentence', `big_number "${shown}" is not restated in words anywhere`);
    }
  }
}

function validateFile(file) {
  let card;
  try {
    card = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(file, 'json', `cannot parse: ${e.message}`);
    return;
  }
  const tplName = card.template;
  const tpl = schema.templates[tplName];
  if (!tpl) {
    fail(file, 'template', `unknown template "${tplName}"`);
    return;
  }
  checkLengths(file, card, tpl);
  checkRules(file, card, tpl, tplName);
}

const files = process.argv.slice(2);
if (!files.length) {
  const dir = path.join(ROOT, 'content');
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => files.push(path.join(dir, f)));
  }
}
if (!files.length) {
  console.log('validate: nothing to check');
  process.exit(0);
}

files.forEach(validateFile);

if (warnings.length) {
  console.log('\nWARNINGS — worth a look, not blocking:\n');
  warnings.forEach(w => console.log('  ' + w + '\n'));
}
if (failures.length) {
  console.error('\nFAILED — nothing renders until these are fixed:\n');
  failures.forEach(f => console.error('  ' + f + '\n'));
  console.error(`${failures.length} problem(s) across ${files.length} file(s).\n`);
  process.exit(1);
}
console.log(`validate: ${files.length} card(s) passed.`);

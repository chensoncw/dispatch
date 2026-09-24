# dispatch

Automated social card rendering and publishing for **Chenson Wedderburn, REALTORÂ®** â€”
Keller Williams Atlanta Partners, Stockbridge, Georgia.

Four value posts a week to the Facebook Page and Instagram. Rendered, checked and
published without anyone touching a composer.

---

## How it works

```
content/*.json      one record per post â€” the copy, the figures, the source
      â†“
validate.js         refuses anything that breaks a rule. nothing renders until it passes
      â†“
render.html         one renderer, 13 templates, driven by the record
      â†“
render.js           headless Chrome screenshots it at 1080 Ã— 1080 â†’ out/*.png
      â†“
(committed)         a public repo gives the image a public URL
      â†“
publish.js          one Graph call for the Page, two for Instagram
```

Instagram will not accept raw image bytes â€” it fetches from a URL you hand it.
**That is the only reason this repo is public.**

---

## The weekly rhythm

| | |
|---|---|
| **Sunday** | `render.yml` validates and renders the whole week, commits the PNGs |
| | Chenson looks at four images in one sitting |
| **Tueâ€“Fri** | `publish.yml` posts the card whose filename matches that date |

**Approve by exception.** Publishing runs unless a card gets pulled. One look a week
rather than four interruptions.

One card never goes unseen: **the rate card**. It is the figure agents check most often
and the one that goes stale fastest, so `publish.js` refuses it unless `APPROVED=1`.

---

## Running it by hand

```bash
npm install
npx playwright install --with-deps chromium

node scripts/validate.js                      # check everything in content/
node scripts/render.js                        # render everything â†’ out/
node scripts/preflight.js                     # is the token still alive
DRY_RUN=1 node scripts/publish.js content/2026-09-29-market.json
```

---

## Secrets

Settings â†’ Secrets and variables â†’ Actions:

| Secret | What it is |
|---|---|
| `META_PAGE_TOKEN` | Long-lived **Page** access token. Derived from a long-lived user token, it effectively does not expire. |
| `META_PAGE_ID` | The Facebook Page ID |
| `META_IG_USER_ID` | The Instagram Business account ID linked to that Page |

Meta **App Review is not required.** It exists to police apps acting for *other* people.
An app in Development Mode may use the publishing permissions for anyone holding a role
on that app â€” which is Chenson on both sides.

Pin the API version. Meta ships one roughly quarterly with about two years of support,
so a pinned version means nothing shifts underneath. Override with `GRAPH_VERSION`.

---

## The rules, and where they live

`schema.json` holds the field limits **and the rules the validator enforces**. Not style
notes â€” hard gates. Nothing renders if one fails.

- Every claim carries a named outside source and a disclaimer. Holiday cards make no
  claim, so they carry neither.
- Every figure is dated. Never a forecast.
- No bare quantifiers â€” *most, many, usually* are statistics wearing words.
- Echo says what **he** would do. Never "you should".
- Echo never ends on a question, and never introduces a figure Titan did not say.
- Every home row names a professional. The card says what to look at, never what to do.
- Never a price on a repair or a service.
- Anything presented as upcoming must still be upcoming when it publishes.
- No card may lean on a figure that only appears on another card.
- Every stat tile figure must also appear written as a sentence.

`calendar.json` holds every recurring date, its rule, and how far ahead it publishes.
Nothing stores a date for a particular year â€” it stores the rule, so future years compute
themselves.

---

## The cast

**Titan** â€” husky-owl. Army, then real estate. Carries the substance and the figures.
Explains things because he once signed papers he did not understand and got lucky.

**Echo** â€” raccoon-owl. Not in the business, which is the point: he asks what everyone
else is too embarrassed to ask, then lands on what he would do about it.

Titan speaks, Echo checks it back. That exchange is not decoration â€” it is how the
plain-English rule gets enforced in the one place people actually read.

---

## What is not automated

**The six Facebook groups.** Meta removed group publishing from the API, which is why no
scheduler on the market offers it. Those stay a manual Wednesday job.

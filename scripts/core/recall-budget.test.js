'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  allocateBudget,
  consumeTier,
  consumeTiers,
  RESERVE_RATIOS,
  PER_ITEM_DEFAULTS,
  TRUNC_SUFFIX,
} = require('./recall-budget');

test('allocateBudget: reserves sum to total at default ratios', () => {
  const b = allocateBudget(4000);
  assert.equal(b.total, 4000);
  assert.equal(b.reserves.facts, 2000);
  assert.equal(b.reserves.wiki, 1200);
  assert.equal(b.reserves.working, 400);
  assert.equal(b.reserves.sessions, 400);
  // reserves sum == total since 0.5+0.3+0.1+0.1 = 1.0
  const sum = Object.values(b.reserves).reduce((a, x) => a + x, 0);
  assert.equal(sum, 4000);
});

test('allocateBudget: invalid input falls back to default 4000', () => {
  assert.equal(allocateBudget(null).total, 4000);
  assert.equal(allocateBudget(-1).total, 4000);
  assert.equal(allocateBudget('xxx').total, 4000);
  // 0 is valid "no budget" — see scenario 4 below; not a fallback case.
  assert.equal(allocateBudget(0).total, 0);
});

test('consumeTier: empty inputs return zero result', () => {
  const out = consumeTier([], 1000, PER_ITEM_DEFAULTS.fact);
  assert.deepEqual(out, { taken: [], used: 0, dropped: 0 });
  assert.deepEqual(consumeTier(null, 100, PER_ITEM_DEFAULTS.fact), { taken: [], used: 0, dropped: 0 });
  assert.deepEqual(consumeTier(['x'], 0, PER_ITEM_DEFAULTS.fact), { taken: [], used: 0, dropped: 0 });
});

test('consumeTier: respects per-item maxChars (truncation)', () => {
  const longText = 'a'.repeat(500);
  const out = consumeTier([longText], 1000, PER_ITEM_DEFAULTS.fact);
  assert.equal(out.taken.length, 1);
  assert.ok(out.taken[0].text.length <= 300);
  assert.ok(out.taken[0].text.endsWith(TRUNC_SUFFIX));
});

test('consumeTier: respects maxItems', () => {
  const items = Array.from({ length: 20 }, (_, i) => `fact${i}`);
  const out = consumeTier(items, 10000, PER_ITEM_DEFAULTS.fact);
  assert.equal(out.taken.length, PER_ITEM_DEFAULTS.fact.maxItems); // 8
});

test('consumeTier: stops when allowance exhausted', () => {
  const items = ['aaa', 'bbb', 'ccc'];
  const out = consumeTier(items, 5, PER_ITEM_DEFAULTS.fact);
  // first 'aaa' (3 chars) fits; second 'bbb' would push to 6, dropped; third also dropped
  assert.equal(out.taken.length, 1);
  assert.equal(out.used, 3);
  assert.equal(out.dropped, 2);
});

test('consumeTier: accepts {text, source} object form', () => {
  const out = consumeTier([{ text: 'abc', source: { kind: 'fact', id: 'f1' } }], 100, PER_ITEM_DEFAULTS.fact);
  assert.equal(out.taken.length, 1);
  assert.equal(out.taken[0].text, 'abc');
  assert.deepEqual(out.taken[0].source, { kind: 'fact', id: 'f1' });
});

test('consumeTiers: scenario 1 — facts fill exactly, no spillover', () => {
  const facts = Array.from({ length: 8 }, () => 'a'.repeat(250)); // 8 × 250 = 2000 chars
  const out = consumeTiers({ items: { facts }, totalChars: 4000 });
  assert.equal(out.taken.facts.length, 8);
  assert.equal(out.used.facts, 2000);
  assert.equal(out.totalUsed, 2000);
  // wiki/working/sessions empty — all spillover unused
  assert.equal(out.taken.wiki.length, 0);
  assert.equal(out.taken.working.length, 0);
  assert.equal(out.taken.sessions.length, 0);
});

test('consumeTiers: scenario 2 — empty facts, full spillover to wiki', () => {
  const wiki = Array.from({ length: 3 }, () => 'w'.repeat(500)); // 3 × 500 = 1500 chars
  const out = consumeTiers({ items: { facts: [], wiki }, totalChars: 4000 });
  // facts allocated 2000, all unused → spillover into wiki
  // wiki allowance = wiki.reserve(1200) + spillover(2000) = 3200
  // wiki consumes 1500, fits. wiki maxItems=3 reached.
  assert.equal(out.taken.facts.length, 0);
  assert.equal(out.taken.wiki.length, 3);
  assert.equal(out.used.wiki, 1500);
});

test('consumeTiers: scenario 3 — large wiki cannot starve facts', () => {
  const facts = Array.from({ length: 3 }, () => 'f'.repeat(250));
  const wiki = Array.from({ length: 10 }, () => 'w'.repeat(500));
  const out = consumeTiers({ items: { facts, wiki }, totalChars: 4000 });
  // facts run first with reserve 2000; consume 3 × 250 = 750.
  assert.equal(out.taken.facts.length, 3);
  assert.equal(out.used.facts, 750);
  // wiki maxItems=3 caps it; should pick 3 entries (each 500).
  assert.equal(out.taken.wiki.length, 3);
});

test('consumeTiers: scenario 4 — zero budget produces empty', () => {
  const out = consumeTiers({
    items: { facts: ['a'], wiki: ['b'] },
    totalChars: 0,
  });
  assert.equal(out.totalUsed, 0);
  assert.equal(out.taken.facts.length, 0);
  assert.equal(out.taken.wiki.length, 0);
});

test('consumeTiers: scenario 5 — facts spill exactly into wiki+working+sessions', () => {
  // facts empty → 2000 spillover. wiki, working, sessions each get a chance.
  const wiki = ['w'.repeat(500)];
  const working = ['k'.repeat(400)];
  const sessions = ['s'.repeat(200)];
  const out = consumeTiers({ items: { facts: [], wiki, working, sessions }, totalChars: 4000 });
  assert.equal(out.taken.wiki.length, 1);
  assert.equal(out.taken.working.length, 1);
  assert.equal(out.taken.sessions.length, 1);
  assert.equal(out.totalUsed, 1100);
});

test('consumeTiers: scenario 6 — every tier filled at base reserve', () => {
  // 8 facts × 250 = 2000 (exactly facts.reserve)
  // 3 wiki × 400 = 1200 (exactly wiki.reserve)
  // 1 working × 400 = 400 (exactly working.reserve)
  // 2 sessions × 200 = 400 (exactly sessions.reserve)
  const out = consumeTiers({
    items: {
      facts: Array.from({ length: 8 }, () => 'f'.repeat(250)),
      wiki: Array.from({ length: 3 }, () => 'w'.repeat(400)),
      working: ['k'.repeat(400)],
      sessions: Array.from({ length: 2 }, () => 's'.repeat(200)),
    },
    totalChars: 4000,
  });
  assert.equal(out.totalUsed, 4000);
  assert.equal(out.taken.facts.length, 8);
  assert.equal(out.taken.wiki.length, 3);
  assert.equal(out.taken.working.length, 1);
  assert.equal(out.taken.sessions.length, 2);
});

test('consumeTiers: invariant — facts NEVER yield reserve to other tiers', () => {
  // facts has 8 items × 250 → exactly 2000, fills reserve. wiki has 10 huge
  // items but should NOT eat into facts reserve.
  const facts = Array.from({ length: 8 }, () => 'f'.repeat(250));
  const wiki = Array.from({ length: 10 }, () => 'w'.repeat(500));
  const out = consumeTiers({ items: { facts, wiki }, totalChars: 4000 });
  assert.equal(out.used.facts, 2000, 'facts must consume full reserve');
  assert.equal(out.taken.facts.length, 8);
});

test('consumeTiers: truncated flag set when items exceed allowance', () => {
  const out = consumeTiers({
    items: { facts: Array.from({ length: 20 }, () => 'f'.repeat(250)) },
    totalChars: 4000,
  });
  assert.equal(out.taken.facts.length, 8);   // maxItems cap
  assert.equal(out.truncated, true);          // 20 - 8 dropped due to maxItems => truncated=true
});

test('consumeTiers: invalid items field treats as empty', () => {
  const out = consumeTiers({ items: { facts: 'not-an-array' }, totalChars: 4000 });
  assert.equal(out.taken.facts.length, 0);
  assert.equal(out.totalUsed, 0);
});

test('consumeTiers: missing tier defaults to empty', () => {
  // Only facts provided.
  const out = consumeTiers({ items: { facts: ['a'] }, totalChars: 4000 });
  assert.deepEqual(out.taken.wiki, []);
  assert.deepEqual(out.taken.working, []);
  assert.deepEqual(out.taken.sessions, []);
});

test('consumeTiers: per-item override is honored', () => {
  const tiny = Array.from({ length: 5 }, () => 'a'.repeat(100));
  const out = consumeTiers({
    items: { facts: tiny },
    totalChars: 4000,
    perItem: { fact: { maxChars: 30, maxItems: 3 } },
  });
  assert.equal(out.taken.facts.length, 3, 'override maxItems=3');
  for (const item of out.taken.facts) {
    assert.ok(item.text.length <= 30, `override maxChars=30; got ${item.text.length}`);
  }
});

test('consumeTiers: pure module — no daemon/memory imports', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recall-budget.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['./memory', '../memory', './daemon', '../daemon', './recall-redact', './recall-format']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`);
    assert.doesNotMatch(code, re, `recall-budget must not require ${banned}`);
  }
});

test('exported constants reflect documented design', () => {
  assert.equal(RESERVE_RATIOS.facts + RESERVE_RATIOS.wiki + RESERVE_RATIOS.working + RESERVE_RATIOS.sessions, 1.0);
  assert.equal(PER_ITEM_DEFAULTS.fact.maxChars, 300);
  assert.equal(PER_ITEM_DEFAULTS.wiki.maxChars, 500);
  assert.equal(PER_ITEM_DEFAULTS.working.maxChars, 400);
  assert.equal(PER_ITEM_DEFAULTS.session.maxChars, 200);
});

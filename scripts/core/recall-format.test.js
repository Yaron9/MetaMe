'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { formatRecallBlock, TIER_LABELS, TIER_ORDER } = require('./recall-format');

test('formatRecallBlock: empty input → empty string with chars=0', () => {
  const expected = { text: '', sources: [], isEmpty: true, chars: 0 };
  assert.deepEqual(formatRecallBlock({}), expected);
  assert.deepEqual(formatRecallBlock(undefined), expected);
  assert.deepEqual(formatRecallBlock({ facts: [], wiki: [] }), expected);
});

test('formatRecallBlock: non-empty starts with \\n\\n (intentHint convention)', () => {
  const out = formatRecallBlock({
    facts: [{ text: 'a fact', source: null }],
  });
  assert.ok(out.text.startsWith('\n\n'), 'must start with \\n\\n for safe concat');
  assert.equal(out.isEmpty, false);
});

test('formatRecallBlock: facts-only renders with Facts label', () => {
  const out = formatRecallBlock({
    facts: [{ text: 'fact one', source: null }, { text: 'fact two', source: null }],
  });
  assert.match(out.text, /\[Recall context:\nFacts:\n- fact one\n- fact two\n\]/);
});

test('formatRecallBlock: tiers appear in fixed order facts → wiki → working → sessions', () => {
  const out = formatRecallBlock({
    sessions: [{ text: 'session entry', source: null }],
    working:  [{ text: 'working entry', source: null }],
    wiki:     [{ text: 'wiki entry', source: null }],
    facts:    [{ text: 'fact entry', source: null }],
  });
  const factsIdx    = out.text.indexOf('Facts:');
  const wikiIdx     = out.text.indexOf('Wiki:');
  const workingIdx  = out.text.indexOf('Working memory:');
  const sessionsIdx = out.text.indexOf('Past sessions:');
  assert.ok(factsIdx > 0 && factsIdx < wikiIdx);
  assert.ok(wikiIdx < workingIdx);
  assert.ok(workingIdx < sessionsIdx);
});

test('formatRecallBlock: source ids render as [ref:<id>] tags', () => {
  const out = formatRecallBlock({
    facts: [
      { text: 'fact a', source: { kind: 'fact', id: 'mi_42' } },
      { text: 'fact b', source: { kind: 'fact', id: 'mi_99' } },
    ],
  });
  assert.match(out.text, /- fact a \[ref:mi_42\]/);
  assert.match(out.text, /- fact b \[ref:mi_99\]/);
});

test('formatRecallBlock: wiki source renders as [wiki:<slug>] when no id', () => {
  const out = formatRecallBlock({
    wiki: [{ text: 'wiki excerpt', source: { kind: 'wiki', slug: 'session-management' } }],
  });
  assert.match(out.text, /- wiki excerpt \[wiki:session-management\]/);
});

test('formatRecallBlock: session source renders as [session:<sessionId>]', () => {
  const out = formatRecallBlock({
    sessions: [{ text: 'past summary', source: { kind: 'episode', sessionId: 's_123' } }],
  });
  assert.match(out.text, /- past summary \[session:s_123\]/);
});

test('formatRecallBlock: source kind alone renders as [<kind>]', () => {
  const out = formatRecallBlock({
    working: [{ text: 'now state', source: { kind: 'working' } }],
  });
  assert.match(out.text, /- now state \[working\]/);
});

test('formatRecallBlock: sources flat list aggregates with tier annotation', () => {
  const out = formatRecallBlock({
    facts: [{ text: 'fa', source: { id: 'f1' } }],
    wiki:  [{ text: 'wi', source: { slug: 'topic' } }],
  });
  assert.deepEqual(out.sources, [
    { tier: 'facts', id: 'f1' },
    { tier: 'wiki',  slug: 'topic' },
  ]);
});

test('formatRecallBlock: items without source still render but contribute no source entry', () => {
  const out = formatRecallBlock({
    facts: [{ text: 'no source', source: null }, { text: 'has src', source: { id: 'x1' } }],
  });
  assert.match(out.text, /- no source\n/);
  assert.match(out.text, /- has src \[ref:x1\]/);
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].id, 'x1');
});

test('formatRecallBlock: skips empty-text items', () => {
  const out = formatRecallBlock({
    facts: [{ text: '', source: null }, { text: 'real', source: null }],
  });
  assert.match(out.text, /- real/);
  assert.doesNotMatch(out.text, /- *\n/, 'should not produce empty bullet line');
});

test('formatRecallBlock: skips entire tier when all items empty', () => {
  const out = formatRecallBlock({ facts: [{ text: '', source: null }] });
  assert.equal(out.isEmpty, true, 'all-empty tier collapses to empty result');
});

test('formatRecallBlock: bracket structure is balanced', () => {
  const out = formatRecallBlock({
    facts: [{ text: 'x', source: { id: 'a' } }],
  });
  // Output bracket structure must close: opens with [Recall context: and ends with ]
  assert.match(out.text, /^\n\n\[Recall context:[\s\S]+\n\]$/);
});

test('TIER_ORDER and TIER_LABELS are aligned', () => {
  assert.deepEqual(TIER_ORDER, ['facts', 'wiki', 'working', 'sessions']);
  for (const tier of TIER_ORDER) {
    assert.ok(typeof TIER_LABELS[tier] === 'string' && TIER_LABELS[tier].length > 0,
      `missing label for ${tier}`);
  }
});

test('formatRecallBlock: chars matches text.length on non-empty (Codex Step 9 P2)', () => {
  const out = formatRecallBlock({ facts: [{ text: 'hello', source: null }] });
  assert.equal(out.chars, out.text.length);
  assert.ok(out.chars > 0);
});

test('formatRecallBlock: sanitizes embedded newlines and ] in text (Codex Step 9 P2)', () => {
  const out = formatRecallBlock({
    facts: [
      { text: 'line one\nline two', source: null },
      { text: 'has ] bracket inside', source: null },
    ],
  });
  // Newlines collapsed to literal \n marker — bullet stays one line.
  assert.match(out.text, /- line one \\n line two/);
  // Closing bracket escaped so outer [Recall context: ... ] is unambiguous.
  assert.match(out.text, /- has \\] bracket inside/);
});

test('formatRecallBlock: pure module — no daemon/memory imports', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recall-format.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['./memory', '../memory', './daemon', '../daemon', './recall-redact', './recall-plan', './recall-budget', './recall-audit-db']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`);
    assert.doesNotMatch(code, re, `recall-format must not require ${banned}`);
  }
});

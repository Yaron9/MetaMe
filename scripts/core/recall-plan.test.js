'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { planRecall } = require('./recall-plan');

const RUNTIME = { engine: 'claude', sessionStarted: true };
const SCOPE = { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' };

test('recall-plan: shape + non-string + empty', async (t) => {
  await t.test('non-string returns empty plan', () => {
    const p = planRecall({ text: undefined, runtime: RUNTIME, scope: SCOPE });
    assert.equal(p.shouldRecall, false);
    assert.equal(p.reason, '');
    assert.deepEqual(p.anchors, []);
    assert.deepEqual(p.modes, []);
    assert.equal(p.hintBudget, 0);
  });

  await t.test('too-short text does not trigger', () => {
    assert.equal(planRecall({ text: '嗯', runtime: RUNTIME, scope: SCOPE }).shouldRecall, false);
    assert.equal(planRecall({ text: 'hi', runtime: RUNTIME, scope: SCOPE }).shouldRecall, false);
  });

  await t.test('slash-command prefixes are non-triggers', () => {
    for (const cmd of ['/status', '/tasks', '/agent', '/wiki', '/engine', '/help', '/clear']) {
      const p = planRecall({ text: `${cmd} 上次`, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, false, `${cmd} should be non-trigger`);
    }
  });
});

test('recall-plan: explicit history triggers (ZH)', async (t) => {
  const cases = [
    '上次我们讨论过 daemon 的崩溃',
    '前几天提到的那个改 daemon 的方案',
    '上周说的方案',
    '前阵子做过的那个 bug',
    '之前说过这种用法',
    '还记得那个 bug 吗',
    '记不记得 daemon 改了什么',
  ];
  for (const text of cases) {
    await t.test(`triggers on: ${text}`, () => {
      const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, true, `should trigger: ${text}`);
      assert.equal(p.reason, 'explicit-history');
      assert.ok(p.modes.includes('facts'));
      assert.ok(p.modes.includes('sessions'));
    });
  }
});

test('recall-plan: explicit history triggers (EN)', async (t) => {
  const cases = ['last time we shipped this', 'previously you said', 'remember when we hit that bug', 'do you remember the daemon fix', 'earlier we discussed it'];
  for (const text of cases) {
    await t.test(`triggers on: ${text}`, () => {
      const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, true);
      assert.equal(p.reason, 'explicit-history');
    });
  }
});

test('recall-plan: decision-recall triggers', async (t) => {
  const cases = ['为什么这么定的', '当时怎么决定的', '以前怎么处理这种'];
  for (const text of cases) {
    await t.test(`triggers on: ${text}`, () => {
      const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, true);
      assert.equal(p.reason, 'decision-recall');
      assert.ok(p.modes.includes('wiki'));
      assert.ok(p.modes.includes('working'));
    });
  }
});

test('recall-plan: recurrence triggers', async (t) => {
  const cases = ['这个 bug 又出现了', '又遇到了那种问题', '同样的 bug', '之前的 bug 再次出现'];
  for (const text of cases) {
    await t.test(`triggers on: ${text}`, () => {
      const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, true);
      assert.equal(p.reason, 'recurrence');
      assert.ok(p.modes.includes('sessions'));
    });
  }
});

test('recall-plan: procedural triggers', async (t) => {
  const cases = ['这个怎么做来着', '流程是什么', '步骤是什么', '以后遇到这种情况怎么办'];
  for (const text of cases) {
    await t.test(`triggers on: ${text}`, () => {
      const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, true);
      assert.equal(p.reason, 'procedural');
      assert.ok(p.modes.includes('wiki'));
    });
  }
});

test('recall-plan: anchor-only triggers when phrase missing but ≥2 anchors', () => {
  const text = 'check scripts/memory.js and scripts/core/recall-plan.js for archiveItem behavior';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.reason, 'anchor-match');
  assert.ok(p.anchors.length >= 2);
});

test('recall-plan: single anchor + no phrase does NOT trigger', () => {
  const text = 'open scripts/memory.js for me';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, false);
});

test('recall-plan: anchors are emitted as redacted labels', () => {
  const text = '上次改的 scripts/memory.js 里 saveFacts() 出错码 ENOENT';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  // Anchors are kind-prefixed labels.
  const all = p.anchors.join(' ');
  assert.match(all, /file:scripts\/memory\.js/);
  assert.match(all, /errcode:ENOENT/);
  // No raw text from prompt should appear (e.g. 上次, 改的).
  for (const a of p.anchors) {
    assert.doesNotMatch(a, /上次|改的/, `anchor must not contain raw user phrase: ${a}`);
    assert.ok(a.length <= 64, `anchor must be ≤64 chars: ${a}`);
  }
});

test('recall-plan: hintBudget grows with anchors but is capped', () => {
  const noAnchors = planRecall({ text: '还记得吗', runtime: RUNTIME, scope: SCOPE });
  assert.equal(noAnchors.shouldRecall, true);
  assert.ok(noAnchors.hintBudget >= 800);

  const withAnchors = planRecall({
    text: '上次的 scripts/memory.js 和 scripts/core/recall-plan.js 还有 scripts/core/memory-mutate.js 和 scripts/core/recall-redact.js',
    runtime: RUNTIME, scope: SCOPE,
  });
  assert.ok(withAnchors.hintBudget >= noAnchors.hintBudget);
  assert.ok(withAnchors.hintBudget <= 4000, 'budget capped at 4000');
});

test('recall-plan: long text is truncated for scan', () => {
  // text length > MAX_TEXT_FOR_SCAN; trigger phrase placed AFTER the cap.
  const padding = 'x '.repeat(2500); // 5000+ chars
  const text = padding + ' 还记得吗';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  // Phrase fell outside MAX_TEXT_FOR_SCAN=4000 => no trigger
  assert.equal(p.shouldRecall, false);
});

test('recall-plan: pure module — no daemon/memory/runtime imports', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recall-plan.js'), 'utf8');
  // Strip comments first so docstrings cannot trigger the assertion.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['./memory', './daemon', '../daemon', './intent-registry']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`);
    assert.doesNotMatch(code, re, `recall-plan must not require ${banned}`);
  }
});

test('recall-plan: anchor extraction caps at MAX_ANCHORS', () => {
  // 12 file anchors should produce ≤ 8 in output.
  const files = Array.from({ length: 12 }, (_, i) => `scripts/foo${i}.js`).join(' ');
  const p = planRecall({ text: '上次改了 ' + files, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  assert.ok(p.anchors.length <= 8, `anchors capped at 8, got ${p.anchors.length}`);
});

test('recall-plan: deduplicates identical anchors', () => {
  const text = '上次改 scripts/memory.js scripts/memory.js scripts/memory.js';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  // Only one unique anchor regardless of how many times it appears.
  const fileAnchors = p.anchors.filter(a => a.startsWith('file:scripts/memory.js'));
  assert.equal(fileAnchors.length, 1);
});

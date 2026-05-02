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

test('recall-plan: decision-recall triggers (no anchors → no working tier)', async (t) => {
  // Quality Step 4: pure historical decision questions without anchors must
  // NOT pull current task state. They get facts + wiki, NOT working.
  const cases = ['为什么这么定的', '当时怎么决定的', '以前怎么处理这种'];
  for (const text of cases) {
    await t.test(`triggers on: ${text}`, () => {
      const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
      assert.equal(p.shouldRecall, true);
      assert.equal(p.reason, 'decision-recall');
      assert.ok(p.modes.includes('wiki'));
      assert.ok(!p.modes.includes('working'),
        `pure decision-recall must not pull current task state, got modes: ${p.modes}`);
    });
  }
});

test('recall-plan: decision-recall WITH anchors → working tier added', () => {
  // Anchors signal the user is referring to specific files/fns the agent
  // may also be touching now — current task state becomes relevant context.
  const p = planRecall({
    text: '为什么这么定的 scripts/memory.js 的 saveFacts() 这个返回值',
    runtime: RUNTIME, scope: SCOPE,
  });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.reason, 'decision-recall');
  assert.ok(p.anchors.length > 0);
  assert.ok(p.modes.includes('wiki'));
  assert.ok(p.modes.includes('working'),
    'decision-recall + anchors should add working tier');
});

test('Quality Step 4 — explicit-history without anchors: NO working tier', () => {
  // "还记得吗" alone is pure historical recall; current task state would
  // pollute the prompt with unrelated current-work context.
  const p = planRecall({ text: '还记得吗 那个事儿', runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.reason, 'explicit-history');
  assert.equal(p.anchors.length, 0, 'sanity: no anchors');
  assert.ok(!p.modes.includes('working'),
    `explicit-history without anchors must skip working tier, got modes: ${p.modes}`);
});

test('Quality Step 4 — explicit-history WITH anchors: working tier added', () => {
  // Anchors mean the user is referring to specific code; current task state
  // is likely intersecting with that work and useful as context.
  const p = planRecall({
    text: '还记得上次改的 scripts/memory.js 里的 saveFacts() 吗',
    runtime: RUNTIME, scope: SCOPE,
  });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.reason, 'explicit-history');
  assert.ok(p.anchors.length >= 1);
  assert.ok(p.modes.includes('working'),
    'explicit-history + anchors should add working tier');
});

test('Quality Step 4 — recurrence ALWAYS adds working (current behaviour by definition)', () => {
  // "又出现这个 bug" is inherently a current-state question — the agent's
  // working memory is the most relevant single source.
  const p = planRecall({ text: '这个 bug 又出现了', runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.reason, 'recurrence');
  assert.ok(p.modes.includes('working'),
    'recurrence must always include working — it IS about current state');
});

test('Quality Step 4 — anchor-only mode: working not auto-added', () => {
  // anchor-match without a recurrence/explicit-history phrase doesn't
  // imply we want current task state.
  const p = planRecall({
    text: 'check scripts/foo.js scripts/bar.js for askClaude() behaviour',
    runtime: RUNTIME, scope: SCOPE,
  });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.reason, 'anchor-match');
  assert.ok(!p.modes.includes('working'),
    'anchor-only must not pull working tier');
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

test('recall-plan: extended trigger phrases (Codex Step 7 P2)', async (t) => {
  await t.test('记得当时 (explicit-history extension)', () => {
    assert.equal(planRecall({ text: '记得当时怎么改的吗', runtime: RUNTIME, scope: SCOPE }).reason, 'explicit-history');
  });
  await t.test('之前修过 / 改过 / 实现过 (explicit-history extension)', () => {
    assert.equal(planRecall({ text: '之前修过这个 bug', runtime: RUNTIME, scope: SCOPE }).reason, 'explicit-history');
    assert.equal(planRecall({ text: '之前实现过这个功能', runtime: RUNTIME, scope: SCOPE }).reason, 'explicit-history');
    assert.equal(planRecall({ text: '之前改过的那个文件', runtime: RUNTIME, scope: SCOPE }).reason, 'explicit-history');
  });
  await t.test('之前怎么处理 (decision-recall extension)', () => {
    assert.equal(planRecall({ text: '之前怎么处理这种情况', runtime: RUNTIME, scope: SCOPE }).reason, 'decision-recall');
  });
  await t.test('extended EN phrases', () => {
    assert.equal(planRecall({ text: 'as discussed earlier we settled on this', runtime: RUNTIME, scope: SCOPE }).reason, 'explicit-history');
    assert.equal(planRecall({ text: 'how did we handle this before', runtime: RUNTIME, scope: SCOPE }).reason, 'explicit-history');
  });
});

test('recall-plan: env-var anchor extraction (Codex Step 7 P2)', () => {
  const text = '上次设置 OPENAI_API_KEY 和 DATABASE_URL 之后 daemon 没起来';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  const all = p.anchors.join(' ');
  assert.match(all, /env-var:OPENAI_API_KEY/);
  assert.match(all, /env-var:DATABASE_URL/);
});

test('recall-plan: .env file anchor extraction', () => {
  const text = '还记得吗 scripts/foo/.env 那个设置';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  assert.ok(p.anchors.some(a => a.includes('.env')), `expected .env anchor, got: ${p.anchors.join(',')}`);
});

test('recall-plan: slash-prefix non-trigger requires word boundary', async (t) => {
  await t.test('exact /status with space remains non-trigger', () => {
    assert.equal(planRecall({ text: '/status 上次的事', runtime: RUNTIME, scope: SCOPE }).shouldRecall, false);
  });
  await t.test('/statusx is NOT excluded — fall-through to phrase scan', () => {
    const p = planRecall({ text: '/statusx 还记得吗', runtime: RUNTIME, scope: SCOPE });
    assert.equal(p.shouldRecall, true, 'non-command prefix must allow recall');
  });
});

test('recall-plan: hintBudget cap is reachable (Codex Step 7 P2)', () => {
  // 8 anchors × 200 + 800 base = 2400; cap is 2400 so this matches exactly.
  const files = Array.from({ length: 8 }, (_, i) => `scripts/f${i}.js`).join(' ');
  const p = planRecall({ text: '上次改了 ' + files, runtime: RUNTIME, scope: SCOPE });
  assert.equal(p.shouldRecall, true);
  assert.equal(p.anchors.length, 8);
  assert.equal(p.hintBudget, 2400);
});

test('recall-plan: deduplicates identical anchors', () => {
  const text = '上次改 scripts/memory.js scripts/memory.js scripts/memory.js';
  const p = planRecall({ text, runtime: RUNTIME, scope: SCOPE });
  // Only one unique anchor regardless of how many times it appears.
  const fileAnchors = p.anchors.filter(a => a.startsWith('file:scripts/memory.js'));
  assert.equal(fileAnchors.length, 1);
});

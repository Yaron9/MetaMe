'use strict';

/**
 * E2E test for the complete reactive lifecycle.
 *
 * Uses a temporary fixture project (not real ~/AGI/AgentScientist) to avoid
 * polluting production workspace. All archive/topic side effects are isolated.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { handleReactiveOutput, parseReactiveSignals } = require('./daemon-reactive-lifecycle');

// ── Fixture helpers ──

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-scientist-'));
  // Create workspace structure
  for (const sub of ['workspace/notes', 'workspace/experiments', 'workspace/drafts', 'scripts']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  // Copy real business scripts into fixture
  const agentScientistScripts = path.join(__dirname, '..', '..', 'AgentScientist', 'scripts');
  for (const script of ['research-verifier.js', 'research-archive.js', 'topic-pool.js']) {
    const src = path.join(agentScientistScripts, script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dir, 'scripts', script));
    }
  }
  // Create topics.md
  fs.writeFileSync(path.join(dir, 'workspace', 'topics.md'), [
    '# 课题池', '', '## pending',
    '- [t1] Test Topic Alpha (priority: 1)',
    '- [t2] Test Topic Beta (priority: 2)',
    '', '## active', '', '## completed', '', '## abandoned', '',
  ].join('\n'));
  // Create scientist state file at the real protocol path: <metameDir>/reactive/scientist/state.md
  const metameDir = path.join(dir, '.metame');
  const reactiveDir = path.join(metameDir, 'reactive', 'scientist');
  fs.mkdirSync(reactiveDir, { recursive: true });
  fs.writeFileSync(path.join(reactiveDir, 'state.md'), [
    '# 科研状态',
    'project: "Test Topic Alpha"',
    'phase: writing',
    'status: active',
    'round: 5',
    `last_update: "${new Date().toISOString()}"`,
    '',
    'history:',
    '  - phase: topic',
    '    result: confirmed',
    '    date: "2026-03-01"',
    '  - phase: literature',
    '    result: confirmed',
    '    date: "2026-03-05"',
  ].join('\n'));
  return { dir, metameDir };
}

function makeDeps(overrides = {}) {
  const state = { reactive: {}, budget: { date: '2026-03-16', tokens_used: 0 } };
  const dispatches = [];
  const notifications = [];
  const logs = [];
  return {
    state, dispatches, notifications, logs,
    deps: {
      log: (level, msg) => { logs.push({ level, msg }); },
      loadState: () => state,
      saveState: () => {},
      checkBudget: () => true,
      handleDispatchItem: (item) => { dispatches.push(item); },
      notifyUser: (msg) => { notifications.push(msg); },
      ...overrides,
    },
  };
}

// ── Tests ──

describe('E2E: reactive cycle with fixture project', () => {
  let fixture;
  let CONFIG;

  beforeEach(() => {
    fixture = makeTmpProject();
    CONFIG = {
      projects: {
        scientist: {
          reactive: true,
          cwd: fixture.dir,
          team: [
            { key: 'sci_scout' },
            { key: 'sci_thinker' },
            { key: 'sci_lab' },
            { key: 'sci_writer' },
          ],
        },
      },
    };
  });

  afterEach(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('full cycle: scout → scientist → thinker → scientist → COMPLETE with archive + topic flow', () => {
    const { deps, dispatches, state, notifications } = makeDeps({
      // Use real verifier pointed at fixture
      runVerifier: () => ({ passed: true, phase: 'writing', details: 'OK', artifacts: [], hints: [] }),
    });
    // Override metameDir so completion hooks read state from fixture protocol path
    deps.metameDir = fixture.metameDir;

    // Activate t1 in topics so there's an active topic to complete
    const topicEnv = { ...process.env, TOPICS_CWD: fixture.dir };
    require('child_process').execSync('node scripts/topic-pool.js activate t1', {
      cwd: fixture.dir, encoding: 'utf8', env: topicEnv,
    });

    // Step 1: scout completes → triggers scientist
    handleReactiveOutput('sci_scout', 'Found papers', CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].target, 'scientist');
    assert.equal(dispatches[0].new_session, true);
    assert.equal(state.reactive.scientist.depth, 1);

    // Step 2: scientist NEXT_DISPATCH → thinker
    dispatches.length = 0;
    handleReactiveOutput('scientist', 'NEXT_DISPATCH: sci_thinker "Design proposal"', CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].target, 'sci_thinker');
    assert.equal(state.reactive.scientist.depth, 2);

    // Step 3: RESEARCH_COMPLETE
    dispatches.length = 0;
    notifications.length = 0;
    handleReactiveOutput('scientist', 'RESEARCH_COMPLETE', CONFIG, deps);

    // Depth must reset
    assert.equal(state.reactive.scientist.depth, 0);

    // Archive must have been created
    const archiveBase = path.join(fixture.dir, 'workspace', 'archive');
    assert.ok(fs.existsSync(archiveBase), 'archive directory must exist');
    const archives = fs.readdirSync(archiveBase);
    assert.ok(archives.length >= 1, 'at least one archive must be created');
    // Archive must contain metadata.json
    const archiveDir = path.join(archiveBase, archives[0]);
    assert.ok(fs.existsSync(path.join(archiveDir, 'metadata.json')), 'metadata.json must exist');
    assert.ok(fs.existsSync(path.join(archiveDir, 'summary.md')), 'summary.md must exist');

    // Verify archive consumed the state protocol — summary must contain phase history
    const summaryContent = fs.readFileSync(path.join(archiveDir, 'summary.md'), 'utf8');
    assert.ok(summaryContent.includes('topic'), 'summary must contain topic phase from history');
    assert.ok(summaryContent.includes('literature'), 'summary must contain literature phase from history');
    assert.ok(summaryContent.includes('Test Topic Alpha'), 'summary must contain project name');

    // Verify metadata has phases from state
    const metadata = JSON.parse(fs.readFileSync(path.join(archiveDir, 'metadata.json'), 'utf8'));
    assert.ok(metadata.phases_completed.includes('topic'), 'metadata must include topic phase');
    assert.ok(metadata.phases_completed.includes('literature'), 'metadata must include literature phase');

    // Topics must have flowed: t1 → completed, t2 → active (auto-start)
    const topicsContent = fs.readFileSync(path.join(fixture.dir, 'workspace', 'topics.md'), 'utf8');
    assert.ok(topicsContent.includes('## completed'), 'topics must have completed section');
    assert.ok(/## completed[\s\S]*t1/.test(topicsContent), 't1 must be in completed section');
    assert.ok(/## active[\s\S]*t2/.test(topicsContent), 't2 must be in active section (auto-started)');

    // Auto-start dispatch must have fired
    assert.ok(dispatches.length > 0, 'auto-start dispatch must fire');
    const autoStart = dispatches.find(d => d.target === 'scientist' && d.prompt.includes('新课题启动'));
    assert.ok(autoStart, 'auto-start dispatch must target scientist with new topic');
    assert.ok(autoStart.prompt.includes('Test Topic Beta'), 'auto-start must mention next topic title');
    assert.equal(autoStart.new_session, true);

    // Notification must mention completion + next topic
    assert.ok(notifications.some(n => n.includes('完成') && n.includes('Test Topic Beta')),
      'notification must mention completion and next topic');
  });

  it('RESEARCH_COMPLETE without archive scripts gracefully completes', () => {
    // Remove archive script from fixture
    fs.unlinkSync(path.join(fixture.dir, 'scripts', 'research-archive.js'));
    fs.unlinkSync(path.join(fixture.dir, 'scripts', 'topic-pool.js'));

    const { deps, state, notifications } = makeDeps();
    handleReactiveOutput('scientist', 'RESEARCH_COMPLETE', CONFIG, deps);
    assert.equal(state.reactive.scientist.status, 'completed');
    assert.equal(state.reactive.scientist.depth, 0);
    assert.ok(notifications.some(n => n.includes('完成')));
  });

  it('archive failure prevents topic pool from running', () => {
    // Corrupt archive script
    fs.writeFileSync(path.join(fixture.dir, 'scripts', 'research-archive.js'), 'throw new Error("boom");');

    const { deps, logs } = makeDeps();
    // Activate t1
    require('child_process').execSync('node scripts/topic-pool.js activate t1', {
      cwd: fixture.dir, encoding: 'utf8', env: { ...process.env, TOPICS_CWD: fixture.dir },
    });
    handleReactiveOutput('scientist', 'RESEARCH_COMPLETE', CONFIG, deps);

    // Topics should NOT have flowed (archive failed → topic pool skipped)
    const topicsContent = fs.readFileSync(path.join(fixture.dir, 'workspace', 'topics.md'), 'utf8');
    assert.ok(/## active[\s\S]*t1/.test(topicsContent), 't1 must still be active (archive failed, topics not touched)');
    assert.ok(logs.some(l => l.msg.includes('archive failed')), 'archive failure must be logged');
    assert.ok(logs.some(l => l.msg.includes('skipping topic pool')), 'topic pool skip must be logged');
  });
});

describe('E2E: signal parsing edge cases', () => {
  it('mixed output with natural language + NEXT_DISPATCH', () => {
    const output = `
Analysis complete. Key findings:
1. Method A outperforms baseline by 3.2%
2. Ablation confirms component B is critical

NEXT_DISPATCH: sci_writer "Write paper. Results in workspace/experiments/exp_001/"
    `.trim();
    const signals = parseReactiveSignals(output);
    assert.equal(signals.directives.length, 1);
    assert.equal(signals.directives[0].target, 'sci_writer');
    assert.equal(signals.complete, false);
  });

  it('budget gate stops mid-cycle', () => {
    let budgetOk = true;
    const CONFIG_SIMPLE = {
      projects: {
        sci: { reactive: true, team: [{ key: 'worker' }] },
      },
    };
    const { deps, dispatches, state, notifications } = makeDeps({
      checkBudget: () => budgetOk,
    });
    handleReactiveOutput('worker', 'done', CONFIG_SIMPLE, deps);
    assert.equal(dispatches.length, 1);

    budgetOk = false;
    dispatches.length = 0;
    handleReactiveOutput('worker', 'done again', CONFIG_SIMPLE, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.sci.status, 'paused');
    assert.equal(state.reactive.sci.pause_reason, 'budget_exceeded');
  });

  it('depth gate stops at limit', () => {
    const CONFIG_SIMPLE = {
      projects: {
        sci: { reactive: true, team: [{ key: 'worker' }] },
      },
    };
    const { deps, dispatches, state } = makeDeps();
    state.reactive.sci = { depth: 50, max_depth: 50, status: 'running', pause_reason: '', last_signal: '', updated_at: '' };
    handleReactiveOutput('worker', 'done', CONFIG_SIMPLE, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.sci.status, 'paused');
    assert.equal(state.reactive.sci.pause_reason, 'depth_exceeded');
  });

  it('non-reactive teams are completely ignored', () => {
    const config = { projects: { biz: { team: [{ key: 'sales' }] } } };
    const { deps, dispatches } = makeDeps();
    handleReactiveOutput('sales', 'quarterly report done', config, deps);
    assert.equal(dispatches.length, 0);
  });
});

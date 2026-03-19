'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { handleReactiveOutput, parseReactiveSignals, replayEventLog, __test } = require('./daemon-reactive-lifecycle');
const { runProjectVerifier, readPhaseFromState, resolveProjectCwd, appendEvent, projectProgressTsv, loadProjectManifest, resolveProjectScripts, generateStateFile } = __test;

// ── parseReactiveSignals ──────────────────────────────────────

describe('parseReactiveSignals', () => {
  it('parses quoted NEXT_DISPATCH directives', () => {
    const output = 'Some text\nNEXT_DISPATCH: sci_scout "search papers on transformers"\nMore text';
    const result = parseReactiveSignals(output);
    assert.equal(result.directives.length, 1);
    assert.equal(result.directives[0].target, 'sci_scout');
    assert.equal(result.directives[0].prompt, 'search papers on transformers');
    assert.equal(result.complete, false);
  });

  it('parses multiple quoted directives', () => {
    const output = [
      'Plan: dispatch two agents',
      'NEXT_DISPATCH: sci_scout "literature review"',
      'NEXT_DISPATCH: sci_thinker "design proposal"',
    ].join('\n');
    const result = parseReactiveSignals(output);
    assert.equal(result.directives.length, 2);
    assert.equal(result.directives[0].target, 'sci_scout');
    assert.equal(result.directives[1].target, 'sci_thinker');
  });

  it('parses colon-separated format as fallback', () => {
    const output = 'NEXT_DISPATCH: sci_lab: run experiment with config X\n';
    const result = parseReactiveSignals(output);
    assert.equal(result.directives.length, 1);
    assert.equal(result.directives[0].target, 'sci_lab');
    assert.ok(result.directives[0].prompt.includes('run experiment'));
  });

  it('detects RESEARCH_COMPLETE (default signal)', () => {
    const output = 'All phases done.\nRESEARCH_COMPLETE\n';
    const result = parseReactiveSignals(output);
    assert.equal(result.complete, true);
    assert.equal(result.directives.length, 0);
  });

  it('returns empty for no signals', () => {
    const output = 'Just a normal agent response with no directives.';
    const result = parseReactiveSignals(output);
    assert.equal(result.directives.length, 0);
    assert.equal(result.complete, false);
  });

  it('RESEARCH_COMPLETE takes priority even if NEXT_DISPATCH present', () => {
    const output = 'NEXT_DISPATCH: sci_scout "one more"\nRESEARCH_COMPLETE';
    const result = parseReactiveSignals(output);
    assert.equal(result.complete, true);
    // directives still parsed — handler decides priority, but parser must find them
    assert.equal(result.directives.length, 1);
    assert.equal(result.directives[0].target, 'sci_scout');
  });

  it('uses custom completion signal', () => {
    const result = parseReactiveSignals('done MISSION_COMPLETE end', 'MISSION_COMPLETE');
    assert.equal(result.complete, true);
  });

  it('custom signal does not match different text', () => {
    const result = parseReactiveSignals('RESEARCH_COMPLETE', 'MISSION_COMPLETE');
    assert.equal(result.complete, false);
  });
});

// ── handleReactiveOutput ──────────────────────────────────────

function makeDeps(overrides = {}) {
  const state = { reactive: {}, budget: { date: '2026-03-16', tokens_used: 0 } };
  const dispatches = [];
  const notifications = [];
  return {
    state,
    dispatches,
    notifications,
    deps: {
      log: () => {},
      loadState: () => state,
      saveState: () => {},
      checkBudget: () => true,
      handleDispatchItem: (item, _config) => { dispatches.push(item); },
      notifyUser: (msg) => { notifications.push(msg); },
      ...overrides,
    },
  };
}

const REACTIVE_CONFIG = {
  projects: {
    scientist: {
      reactive: true,
      team: [
        { key: 'sci_scout' },
        { key: 'sci_thinker' },
        { key: 'sci_critic' },
        { key: 'sci_lab' },
        { key: 'sci_writer' },
      ],
    },
  },
};

describe('handleReactiveOutput — reactive parent', () => {
  it('dispatches NEXT_DISPATCH with new_session and _reactive', () => {
    const { deps, dispatches } = makeDeps();
    const output = 'NEXT_DISPATCH: sci_scout "search papers"';
    handleReactiveOutput('scientist', output, REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].target, 'sci_scout');
    assert.equal(dispatches[0].new_session, true);
    assert.equal(dispatches[0]._reactive, true);
    assert.equal(dispatches[0].from, 'scientist');
  });

  it('increments depth on NEXT_DISPATCH', () => {
    const { deps, state } = makeDeps();
    handleReactiveOutput('scientist', 'NEXT_DISPATCH: sci_scout "task"', REACTIVE_CONFIG, deps);
    assert.equal(state.reactive.scientist.depth, 1);
    assert.equal(state.reactive.scientist.status, 'running');
  });

  it('stops on budget exceeded', () => {
    const { deps, dispatches, notifications, state } = makeDeps({
      checkBudget: () => false,
    });
    handleReactiveOutput('scientist', 'NEXT_DISPATCH: sci_scout "task"', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.status, 'paused');
    assert.equal(state.reactive.scientist.pause_reason, 'budget_exceeded');
    assert.ok(notifications.length > 0);
  });

  it('stops on depth exceeded', () => {
    const { deps, dispatches, notifications, state } = makeDeps();
    state.reactive.scientist = { depth: 50, max_depth: 50, status: 'running', pause_reason: '', last_signal: '', updated_at: '' };
    handleReactiveOutput('scientist', 'NEXT_DISPATCH: sci_scout "task"', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.status, 'paused');
    assert.equal(state.reactive.scientist.pause_reason, 'depth_exceeded');
    assert.ok(notifications.length > 0);
  });

  it('handles MISSION_COMPLETE — resets depth, sets completed', () => {
    const { deps, dispatches, notifications, state } = makeDeps();
    state.reactive.scientist = { depth: 15, max_depth: 50, status: 'running', pause_reason: '', last_signal: '', updated_at: '' };
    handleReactiveOutput('scientist', 'MISSION_COMPLETE', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.depth, 0);
    assert.equal(state.reactive.scientist.status, 'completed');
    assert.ok(notifications.length > 0);
  });

  it('MISSION_COMPLETE with budget exceeded skips auto-start but still completes', () => {
    const { deps, dispatches, notifications, state } = makeDeps({
      checkBudget: () => false,
    });
    handleReactiveOutput('scientist', 'MISSION_COMPLETE', REACTIVE_CONFIG, deps);
    // Must still complete (budget gate does not block completion itself)
    assert.equal(state.reactive.scientist.status, 'completed');
    assert.equal(state.reactive.scientist.depth, 0);
    // No auto-start dispatch should fire
    assert.equal(dispatches.length, 0);
  });

  it('MISSION_COMPLETE takes priority over NEXT_DISPATCH', () => {
    const { deps, dispatches, state } = makeDeps();
    handleReactiveOutput('scientist', 'NEXT_DISPATCH: sci_scout "task"\nMISSION_COMPLETE', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.status, 'completed');
  });

  it('ignores output with no signals', () => {
    const { deps, dispatches } = makeDeps();
    handleReactiveOutput('scientist', 'Just some regular output', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
  });
});

describe('handleReactiveOutput — team member completion', () => {
  it('triggers parent with new_session on member completion', () => {
    const { deps, dispatches } = makeDeps();
    handleReactiveOutput('sci_scout', 'Here are the papers I found...', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].target, 'scientist');
    assert.equal(dispatches[0].new_session, true);
    assert.equal(dispatches[0]._reactive, true);
    assert.ok(dispatches[0].prompt.includes('sci_scout'));
  });

  it('budget gate blocks member → parent trigger', () => {
    const { deps, dispatches, state } = makeDeps({
      checkBudget: () => false,
    });
    handleReactiveOutput('sci_scout', 'Done with literature', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.status, 'paused');
  });

  it('depth gate blocks member → parent trigger', () => {
    const { deps, dispatches, state } = makeDeps();
    state.reactive.scientist = { depth: 50, max_depth: 50, status: 'running', pause_reason: '', last_signal: '', updated_at: '' };
    handleReactiveOutput('sci_scout', 'Done', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.status, 'paused');
  });

  it('ignores non-reactive parent teams', () => {
    const config = {
      projects: {
        business: {
          team: [{ key: 'hunter' }],
          // no reactive: true
        },
      },
    };
    const { deps, dispatches } = makeDeps();
    handleReactiveOutput('hunter', 'market analysis done', config, deps);
    assert.equal(dispatches.length, 0);
  });
});

// ── Verifier helpers ──────────────────────────────────────────

describe('resolveProjectCwd', () => {
  it('returns null when project has no cwd', () => {
    assert.equal(resolveProjectCwd('scientist', REACTIVE_CONFIG), null);
  });

  it('resolves ~ to homedir', () => {
    const config = { projects: { sci: { cwd: '~/projects/sci' } } };
    const result = resolveProjectCwd('sci', config);
    assert.ok(result.startsWith('/'));
    assert.ok(!result.includes('~'));
    assert.ok(result.endsWith('/projects/sci'));
  });
});

describe('readPhaseFromState', () => {
  it('returns empty string for non-existent file', () => {
    assert.equal(readPhaseFromState('/nonexistent/path.md'), '');
  });
});

describe('runProjectVerifier', () => {
  it('returns null when project has no cwd', () => {
    const deps = { log: () => {} };
    assert.equal(runProjectVerifier('scientist', REACTIVE_CONFIG, deps), null);
  });

  it('returns null when verifier script does not exist', () => {
    const config = { projects: { sci: { cwd: '/tmp/nonexistent-verifier-test' } } };
    const deps = { log: () => {} };
    assert.equal(runProjectVerifier('sci', config, deps), null);
  });
});

// ── Verifier hook integration ─────────────────────────────────

describe('handleReactiveOutput — verifier hook', () => {
  it('injects verifier result into parent prompt when deps.runVerifier returns data', () => {
    const verifierResult = {
      passed: true,
      phase: 'literature',
      details: 'All checks passed',
      artifacts: [],
      hints: ['Consider adding more sources'],
    };
    const { deps, dispatches } = makeDeps({
      runVerifier: () => verifierResult,
    });
    handleReactiveOutput('sci_scout', 'Papers found', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].prompt.includes('[Verifier]'));
    assert.ok(dispatches[0].prompt.includes('phase=literature'));
    assert.ok(dispatches[0].prompt.includes('passed=true'));
    assert.ok(dispatches[0].prompt.includes('All checks passed'));
    assert.ok(dispatches[0].prompt.includes('Hints: Consider adding more sources'));
  });

  it('injects fallback block when deps.runVerifier returns null', () => {
    const { deps, dispatches } = makeDeps({
      runVerifier: () => null,
    });
    handleReactiveOutput('sci_scout', 'Papers found', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].prompt.includes('[Verifier]'));
    assert.ok(dispatches[0].prompt.includes('not configured'));
  });

  it('injects fallback block when no verifier available', () => {
    const { deps, dispatches } = makeDeps();
    handleReactiveOutput('sci_scout', 'Papers found', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    // No cwd in config, runProjectVerifier returns null → fallback block injected
    assert.ok(dispatches[0].prompt.includes('[Verifier]'));
    assert.ok(dispatches[0].prompt.includes('not configured'));
  });

  it('verifier with failed result includes details in prompt', () => {
    const verifierResult = {
      passed: false,
      phase: 'experiment',
      details: 'Missing control group',
      artifacts: [],
      hints: [],
    };
    const { deps, dispatches } = makeDeps({
      runVerifier: () => verifierResult,
    });
    handleReactiveOutput('sci_scout', 'Experiment done', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].prompt.includes('passed=false'));
    assert.ok(dispatches[0].prompt.includes('Missing control group'));
    // No hints line when hints array is empty
    assert.ok(!dispatches[0].prompt.includes('Hints:'));
  });

  it('prompt includes expected format elements (Output summary, NEXT_DISPATCH, MISSION_COMPLETE)', () => {
    const { deps, dispatches } = makeDeps({
      runVerifier: () => null,
    });
    handleReactiveOutput('sci_scout', 'Done with work', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].prompt.includes('Output summary'));
    assert.ok(dispatches[0].prompt.includes('NEXT_DISPATCH'));
    assert.ok(dispatches[0].prompt.includes('MISSION_COMPLETE'));
  });
});

// ── Event Log ─────────────────────────────────────────────────

describe('Event Log', () => {
  let tmpDir;

  it('appendEvent creates file and writes JSON line', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evtlog-test-'));
    const origEventsDir = path.join(os.homedir(), '.metame', 'events');
    // We need to test appendEvent but it writes to a hardcoded EVENTS_DIR.
    // Instead, test via replayEventLog which reads from the same dir.
    // Write directly to simulate appendEvent behavior for isolation.
    const eventsDir = path.join(os.homedir(), '.metame', 'events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const testKey = `_test_evt_${Date.now()}`;
    const logPath = path.join(eventsDir, `${testKey}.jsonl`);
    try {
      appendEvent(testKey, { type: 'PHASE_GATE', phase: 'topic', passed: true });
      assert.ok(fs.existsSync(logPath), 'Event log file should exist');
      const content = fs.readFileSync(logPath, 'utf8');
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.type, 'PHASE_GATE');
      assert.equal(parsed.phase, 'topic');
      assert.ok(parsed.ts, 'Should have timestamp');
    } finally {
      try { fs.unlinkSync(logPath); } catch { /* ok */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('replayEventLog derives phase from PHASE_GATE events', () => {
    const testKey = `_test_replay_${Date.now()}`;
    const tmpMeta = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-test-'));
    const eventsDir = path.join(tmpMeta, 'events');
    const logPath = path.join(eventsDir, `${testKey}.jsonl`);
    try {
      fs.mkdirSync(eventsDir, { recursive: true });
      const events = [
        { ts: '2026-01-01T00:00:00Z', type: 'PHASE_GATE', phase: 'topic', passed: true, artifacts: ['a.md'] },
        { ts: '2026-01-02T00:00:00Z', type: 'PHASE_GATE', phase: 'literature', passed: true, artifacts: ['b.md'] },
      ];
      fs.writeFileSync(logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      const result = replayEventLog(testKey, { log: () => {}, metameDir: tmpMeta });
      assert.equal(result.phase, 'literature');
      assert.equal(result.history.length, 2);
      assert.equal(result.history[0].phase, 'topic');
      assert.equal(result.history[1].phase, 'literature');
    } finally {
      fs.rmSync(tmpMeta, { recursive: true, force: true });
    }
  });

  it('replayEventLog handles MISSION_COMPLETE reset', () => {
    const testKey = `_test_replay_mc_${Date.now()}`;
    const tmpMeta = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-test-'));
    const eventsDir = path.join(tmpMeta, 'events');
    const logPath = path.join(eventsDir, `${testKey}.jsonl`);
    try {
      fs.mkdirSync(eventsDir, { recursive: true });
      const events = [
        { ts: '2026-01-01T00:00:00Z', type: 'MISSION_START', mission_id: '1', mission_title: 'Test' },
        { ts: '2026-01-02T00:00:00Z', type: 'PHASE_GATE', phase: 'topic', passed: true },
        { ts: '2026-01-03T00:00:00Z', type: 'MISSION_COMPLETE' },
      ];
      fs.writeFileSync(logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      const result = replayEventLog(testKey, { log: () => {}, metameDir: tmpMeta });
      assert.equal(result.phase, '');
      assert.equal(result.mission, null);
    } finally {
      fs.rmSync(tmpMeta, { recursive: true, force: true });
    }
  });

  it('replayEventLog tolerates malformed lines (Tolerant Reader)', () => {
    const testKey = `_test_replay_bad_${Date.now()}`;
    const tmpMeta = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-test-'));
    const eventsDir = path.join(tmpMeta, 'events');
    const logPath = path.join(eventsDir, `${testKey}.jsonl`);
    try {
      fs.mkdirSync(eventsDir, { recursive: true });
      const content = '{"ts":"2026-01-01T00:00:00Z","type":"PHASE_GATE","phase":"topic","passed":true}\n{BROKEN LINE\n{"ts":"2026-01-02T00:00:00Z","type":"PHASE_GATE","phase":"design","passed":true}\n';
      fs.writeFileSync(logPath, content, 'utf8');
      const warnings = [];
      const result = replayEventLog(testKey, { log: (level, msg) => { if (level === 'WARN') warnings.push(msg); }, metameDir: tmpMeta });
      assert.equal(result.phase, 'design');
      assert.equal(result.history.length, 2);
      assert.ok(warnings.length > 0, 'Should have logged a warning for malformed line');
    } finally {
      fs.rmSync(tmpMeta, { recursive: true, force: true });
    }
  });

  it('projectProgressTsv generates TSV from events', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsv-test-'));
    const testKey = `_test_tsv_${Date.now()}`;
    const tmpMeta = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-test-'));
    const eventsDir = path.join(tmpMeta, 'events');
    const logPath = path.join(eventsDir, `${testKey}.jsonl`);
    try {
      fs.mkdirSync(eventsDir, { recursive: true });
      const events = [
        { ts: '2026-01-01T00:00:00Z', type: 'PHASE_GATE', phase: 'topic', passed: true, artifacts: ['topic.md'], details: 'ok' },
      ];
      fs.writeFileSync(logPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      projectProgressTsv(tmpDir, testKey, tmpMeta);
      const tsvPath = path.join(tmpDir, 'workspace', 'progress.tsv');
      assert.ok(fs.existsSync(tsvPath), 'TSV file should exist');
      const content = fs.readFileSync(tsvPath, 'utf8');
      assert.ok(content.includes('phase\tresult'), 'Should contain TSV header');
      assert.ok(content.includes('topic\tdone\ttrue'), 'Should contain event row');
    } finally {
      try { fs.unlinkSync(logPath); } catch { /* ok */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Manifest discovery ────────────────────────────────────────

describe('Manifest discovery', () => {
  let tmpDir;

  it('loadProjectManifest returns parsed YAML', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'perpetual.yaml'), 'completion_signal: DONE\nverifier: scripts/my-verifier.js\n', 'utf8');
      const result = loadProjectManifest(tmpDir);
      assert.ok(result !== null);
      assert.equal(result.completion_signal, 'DONE');
      assert.equal(result.verifier, 'scripts/my-verifier.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loadProjectManifest returns null when no file', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    try {
      const result = loadProjectManifest(tmpDir);
      assert.equal(result, null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolveProjectScripts uses manifest overrides', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    try {
      const manifest = { verifier: 'custom/v.js', archiver: 'custom/a.js', mission_queue: 'custom/q.js' };
      const scripts = resolveProjectScripts(tmpDir, manifest);
      assert.equal(scripts.verifier, path.join(tmpDir, 'custom/v.js'));
      assert.equal(scripts.archiver, path.join(tmpDir, 'custom/a.js'));
      assert.equal(scripts.missionQueue, path.join(tmpDir, 'custom/q.js'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolveProjectScripts uses defaults when no manifest', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    try {
      const scripts = resolveProjectScripts(tmpDir, null);
      assert.equal(scripts.verifier, path.join(tmpDir, 'scripts/verifier.js'));
      assert.equal(scripts.archiver, path.join(tmpDir, 'scripts/archiver.js'));
      assert.equal(scripts.missionQueue, path.join(tmpDir, 'scripts/mission-queue.js'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ── Generalization ────────────────────────────────────────────

describe('Generalization', () => {
  it('source code contains no research-specific terms', () => {
    const src = fs.readFileSync(path.join(__dirname, 'daemon-reactive-lifecycle.js'), 'utf8');
    const codeLines = src.split('\n').filter(l => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('\'');
    });
    // RESEARCH_COMPLETE_RE is allowed (backward compat constant)
    const filtered = codeLines.filter(l => !l.includes('RESEARCH_COMPLETE_RE'));
    const bad = filtered.filter(l => /research|科研|课题|论文/i.test(l));
    assert.equal(bad.length, 0, 'Found forbidden terms:\n' + bad.join('\n'));
  });
});

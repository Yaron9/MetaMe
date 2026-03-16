'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { handleReactiveOutput, parseReactiveSignals, __test } = require('./daemon-reactive-lifecycle');
const { runProjectVerifier, readPhaseFromState, resolveProjectCwd } = __test;

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

  it('detects RESEARCH_COMPLETE', () => {
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

  it('handles RESEARCH_COMPLETE — resets depth, sets completed', () => {
    const { deps, dispatches, notifications, state } = makeDeps();
    state.reactive.scientist = { depth: 15, max_depth: 50, status: 'running', pause_reason: '', last_signal: '', updated_at: '' };
    handleReactiveOutput('scientist', 'RESEARCH_COMPLETE', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 0);
    assert.equal(state.reactive.scientist.depth, 0);
    assert.equal(state.reactive.scientist.status, 'completed');
    assert.ok(notifications.length > 0);
  });

  it('RESEARCH_COMPLETE with budget exceeded skips auto-start but still completes', () => {
    const { deps, dispatches, notifications, state } = makeDeps({
      checkBudget: () => false,
    });
    handleReactiveOutput('scientist', 'RESEARCH_COMPLETE', REACTIVE_CONFIG, deps);
    // Must still complete (budget gate does not block completion itself)
    assert.equal(state.reactive.scientist.status, 'completed');
    assert.equal(state.reactive.scientist.depth, 0);
    // No auto-start dispatch should fire
    assert.equal(dispatches.length, 0);
  });

  it('RESEARCH_COMPLETE takes priority over NEXT_DISPATCH', () => {
    const { deps, dispatches, state } = makeDeps();
    handleReactiveOutput('scientist', 'NEXT_DISPATCH: sci_scout "task"\nRESEARCH_COMPLETE', REACTIVE_CONFIG, deps);
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
    assert.ok(dispatches[0].prompt.includes('[验证门结果]'));
    assert.ok(dispatches[0].prompt.includes('phase=literature'));
    assert.ok(dispatches[0].prompt.includes('passed=true'));
    assert.ok(dispatches[0].prompt.includes('All checks passed'));
    assert.ok(dispatches[0].prompt.includes('建议: Consider adding more sources'));
  });

  it('injects fallback failure block when deps.runVerifier returns null', () => {
    const { deps, dispatches } = makeDeps({
      runVerifier: () => null,
    });
    handleReactiveOutput('sci_scout', 'Papers found', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].prompt.includes('[验证门结果]'));
    assert.ok(dispatches[0].prompt.includes('passed=false'));
    assert.ok(dispatches[0].prompt.includes('验证器未配置'));
  });

  it('injects fallback failure block when no verifier available', () => {
    const { deps, dispatches } = makeDeps();
    handleReactiveOutput('sci_scout', 'Papers found', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    // No cwd in config, runProjectVerifier returns error result → failure block injected
    assert.ok(dispatches[0].prompt.includes('[验证门结果]'));
    assert.ok(dispatches[0].prompt.includes('passed=false'));
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
    assert.ok(!dispatches[0].prompt.includes('建议:'));
  });

  it('prompt includes new format elements (产出摘要, NEXT_DISPATCH instructions)', () => {
    const { deps, dispatches } = makeDeps({
      runVerifier: () => null,
    });
    handleReactiveOutput('sci_scout', 'Done with work', REACTIVE_CONFIG, deps);
    assert.equal(dispatches.length, 1);
    assert.ok(dispatches[0].prompt.includes('产出摘要'));
    assert.ok(dispatches[0].prompt.includes('NEXT_DISPATCH'));
    assert.ok(dispatches[0].prompt.includes('RESEARCH_COMPLETE'));
  });
});

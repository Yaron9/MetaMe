'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const agy = require('./agy-state');

describe('agy-state conversation cache', () => {
  it('captures only a newly assigned cwd conversation', () => {
    const cwd = '/tmp/work';
    assert.equal(agy.captureConversationId({ [cwd]: 'old' }, { [cwd]: 'new' }, cwd), 'new');
    assert.equal(agy.captureConversationId({ [cwd]: 'old' }, { [cwd]: 'old' }, cwd), '');
    assert.equal(agy.captureConversationId({}, {}, cwd, 'resume-id'), 'resume-id');
    assert.equal(agy.captureConversationId({ [cwd]: 'resume-id' }, { [cwd]: 'migrated-id' }, cwd, 'resume-id'), 'migrated-id');
  });

  it('rejects malformed cache shapes', () => {
    assert.deepEqual(agy.parseConversationCache('{"/tmp":"id"}'), { '/tmp': 'id' });
    assert.throws(() => agy.parseConversationCache('[]'), /cache_invalid/);
  });
});

describe('agy-state transcript parsing', () => {
  it('preserves partial JSONL tails', () => {
    const first = agy.splitJsonLines('', '{"a":1}\n{"b"');
    assert.deepEqual(first.lines, ['{"a":1}']);
    assert.equal(first.rest, '{"b"');
    const second = agy.splitJsonLines(first.rest, ':2}\n');
    assert.deepEqual(second.lines, ['{"b":2}']);
    assert.equal(second.rest, '');
  });

  it('normalizes tool calls without exposing planner thinking', () => {
    const events = agy.normalizeTranscriptRecord({
      type: 'PLANNER_RESPONSE',
      thinking: 'private',
      tool_calls: [{ name: 'run_command', args: { command: 'pwd' } }],
    });
    assert.deepEqual(events, [{ type: 'tool_use', toolName: 'run_command', toolInput: { command: 'pwd' } }]);
  });

  it('selects the last completed planner response after the latest user turn', () => {
    const records = [
      { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'old answer' },
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'next' },
      { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'working', tool_calls: [{ name: 'x' }] },
      { type: 'PLANNER_RESPONSE', status: 'DONE', content: 'final answer' },
    ];
    assert.equal(agy.selectFinalResponse(records), 'final answer');
    assert.deepEqual(agy.recordsAfterLatestUser(records), records.slice(1));
  });

  it('builds a finalization prompt from tool evidence when no final answer exists', () => {
    const records = [
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'question' },
      { type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'search' }] },
      { type: 'SEARCH_WEB', status: 'DONE', content: 'search result summary' },
      { type: 'RUN_COMMAND', status: 'DONE', content: 'command output' },
    ];

    const evidence = agy.collectToolEvidence(records);
    const prompt = agy.buildFinalizationPrompt('原始问题', records);

    assert.deepEqual(evidence.map(item => item.type), ['SEARCH_WEB', 'RUN_COMMAND']);
    assert.match(prompt, /不要再调用工具/);
    assert.match(prompt, /原始问题/);
    assert.match(prompt, /search result summary/);
    assert.match(prompt, /command output/);
  });

  it('does not build a finalization prompt when no tool evidence exists', () => {
    assert.equal(agy.buildFinalizationPrompt('原始问题', [
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'question' },
      { type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'search' }] },
    ]), '');
  });
});

describe('agy-state safety decisions', () => {
  it('treats dead, malformed, and expired locks as stale', () => {
    assert.equal(agy.isLockStale(null), true);
    assert.equal(agy.isLockStale({ pid: 10, createdAt: 100 }, { now: 200, maxAgeMs: 1000, isProcessAlive: () => true }), false);
    assert.equal(agy.isLockStale({ pid: 10, createdAt: 100 }, { now: 200, maxAgeMs: 1000, isProcessAlive: () => false }), true);
    assert.equal(agy.isLockStale({ pid: 10, createdAt: 100 }, { now: 5000, maxAgeMs: 1000, isProcessAlive: () => true }), false);
    assert.equal(agy.isLockStale({ pid: 10, createdAt: 100 }, { now: 5000, maxAgeMs: 1000 }), true);
  });

  it('allows fallback only before execution starts', () => {
    assert.equal(agy.isFallbackEligible({ phase: 'preflight', executionStarted: false }), true);
    assert.equal(agy.isFallbackEligible({ phase: 'running', executionStarted: true }), false);
    assert.equal(agy.isFallbackEligible({ phase: 'preflight', executionStarted: true }), false);
  });

  it('collects descendants deepest-first for safe process-tree shutdown', () => {
    const rows = [
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 13, ppid: 10 },
      { pid: 99, ppid: 1 },
    ];
    assert.deepEqual(agy.collectDescendantPids(rows, 10), [12, 11, 13]);
  });
});

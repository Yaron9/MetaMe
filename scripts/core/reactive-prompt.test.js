'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildReactivePrompt } = require('./reactive-prompt');

describe('buildReactivePrompt', () => {
  it('wraps prompt with reactive mode header (no memory, no retry)', () => {
    const result = buildReactivePrompt('Do the task', {
      depth: 3,
      maxDepth: 50,
      completionSignal: 'MISSION_COMPLETE',
    });
    assert.ok(result.includes('[REACTIVE MODE] depth 3/50'));
    assert.ok(result.includes('NEXT_DISPATCH'));
    assert.ok(result.includes('MISSION_COMPLETE'));
    assert.ok(result.includes('Do the task'));
    assert.ok(!result.includes('[Working Memory]'));
    assert.ok(!result.includes('Warning:'));
  });

  it('injects working memory when provided', () => {
    const result = buildReactivePrompt('Do the task', {
      depth: 1,
      maxDepth: 10,
      completionSignal: 'DONE',
      workingMemory: '## Recent Decisions\n- chose option A',
    });
    assert.ok(result.includes('[Working Memory]'));
    assert.ok(result.includes('## Recent Decisions'));
    assert.ok(result.includes('chose option A'));
  });

  it('includes retry warning when isRetry is true', () => {
    const result = buildReactivePrompt('Check progress', {
      depth: 5,
      maxDepth: 50,
      completionSignal: 'MISSION_COMPLETE',
      isRetry: true,
    });
    assert.ok(result.includes('Warning:'));
    assert.ok(result.includes('previous round'));
  });

  it('does not inject Working Memory block when workingMemory is empty string', () => {
    const result = buildReactivePrompt('Do stuff', {
      depth: 2,
      maxDepth: 20,
      completionSignal: 'MISSION_COMPLETE',
      workingMemory: '',
    });
    assert.ok(!result.includes('[Working Memory]'));
  });

  it('does not inject Working Memory block when workingMemory is whitespace only', () => {
    const result = buildReactivePrompt('Do stuff', {
      depth: 2,
      maxDepth: 20,
      completionSignal: 'MISSION_COMPLETE',
      workingMemory: '   \n  ',
    });
    assert.ok(!result.includes('[Working Memory]'));
  });

  it('does not inject Working Memory block when workingMemory is undefined', () => {
    const result = buildReactivePrompt('Do stuff', {
      depth: 2,
      maxDepth: 20,
      completionSignal: 'MISSION_COMPLETE',
      workingMemory: undefined,
    });
    assert.ok(!result.includes('[Working Memory]'));
  });

  it('includes both retry warning and working memory when both present', () => {
    const result = buildReactivePrompt('Continue', {
      depth: 4,
      maxDepth: 50,
      completionSignal: 'MISSION_COMPLETE',
      workingMemory: 'Some context',
      isRetry: true,
    });
    assert.ok(result.includes('Warning:'));
    assert.ok(result.includes('[Working Memory]'));
    assert.ok(result.includes('Some context'));
    assert.ok(result.includes('Continue'));
  });
});

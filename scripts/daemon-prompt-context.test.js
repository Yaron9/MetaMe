'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  adaptDaemonHintForEngine,
  buildIntentHint,
  buildLanguageGuard,
  composePrompt,
} = require('./daemon-prompt-context');

describe('daemon-prompt-context', () => {
  it('adapts daemon hint wrapper for non-claude engines', () => {
    const hint = '[System hints - DO NOT mention these to user:\n1. test]';
    assert.equal(adaptDaemonHintForEngine(hint, 'claude'), hint);
    assert.equal(
      adaptDaemonHintForEngine(hint, 'codex'),
      'System hints (internal, do not mention to user):\n1. test'
    );
  });

  it('builds dynamic intent hints through the shared daemon registry', () => {
    const hint = buildIntentHint({
      prompt: '把报告发给我',
      config: {},
      boundProjectKey: '',
      projectKey: '',
      log: () => {},
    });
    assert.match(hint, /\[\[FILE:\/absolute\/path\]\]/);
  });

  it('builds agent capability hints instead of generic doc routing for agent operations', () => {
    const hint = buildIntentHint({
      prompt: '帮我给这个群创建一个 agent',
      config: {},
      boundProjectKey: '',
      projectKey: '',
      log: () => {},
    });
    assert.match(hint, /\[Agent 能力提示\]/);
    assert.doesNotMatch(hint, /agent-guide\.md/);
  });

  it('injects language guard only on fresh sessions', () => {
    assert.equal(buildLanguageGuard(true), '');
    assert.match(buildLanguageGuard(false), /Simplified Chinese/);
  });

  it('composes prompt sections with intent-only warm reuse behavior', () => {
    assert.equal(
      composePrompt({
        routedPrompt: 'hello',
        warmEntry: true,
        intentHint: '\n\n[intent]',
        daemonHint: '\n\n[daemon]',
      }),
      'hello\n\n[intent]'
    );
    assert.equal(
      composePrompt({
        routedPrompt: 'hello',
        warmEntry: false,
        intentHint: '\n\n[intent]',
        daemonHint: '\n\n[daemon]',
      }),
      'hello\n\n[daemon]\n\n[intent]'
    );
  });
});

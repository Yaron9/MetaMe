'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildEnrichedPrompt, resolveDispatchActor } = require('./daemon-team-dispatch');

describe('team-dispatch scoped context', () => {
  it('does not pull legacy reactive or Markdown task mirrors into a dispatch', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-team-dispatch-'));
    for (const [relative, content] of [
      ['reactive/builder/state.md', 'LEGACY PRIVATE STATE'],
      ['memory/now/shared.md', 'LEGACY SHARED STATE'],
      ['memory/shared/tasks.md', 'LEGACY TASK MIRROR'],
    ]) {
      const file = path.join(baseDir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    }
    assert.equal(buildEnrichedPrompt('builder', '实现修复', baseDir), '实现修复');
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('consumes transient inbox messages exactly once', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-team-dispatch-'));
    const inbox = path.join(baseDir, 'memory', 'inbox', 'builder');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, '001.md'), 'review result', 'utf8');
    const first = buildEnrichedPrompt('builder', '实现修复', baseDir);
    assert.match(first, /Agent Inbox/);
    assert.match(first, /review result/);
    assert.equal(buildEnrichedPrompt('builder', '实现修复', baseDir), '实现修复');
    assert.deepEqual(fs.readdirSync(inbox), []);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('normalizes placeholder dispatch sources to user actor', () => {
    assert.deepEqual(resolveDispatchActor('_claude_session', {}), {
      key: 'user', name: '用户', icon: '👤', isUser: true,
    });
  });
});

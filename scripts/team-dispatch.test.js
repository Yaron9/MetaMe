'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildEnrichedPrompt,
  resolveDispatchActor,
  updateDispatchContextFiles,
} = require('./team-dispatch');

describe('team-dispatch scoped context', () => {
  it('prefers target-private now file and excludes shared context by default', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-team-dispatch-'));
    const nowDir = path.join(baseDir, 'memory', 'now');
    fs.mkdirSync(nowDir, { recursive: true });
    fs.writeFileSync(path.join(nowDir, 'builder.md'), 'PRIVATE builder progress', 'utf8');
    fs.writeFileSync(path.join(nowDir, 'shared.md'), 'SHARED team progress', 'utf8');

    const text = buildEnrichedPrompt('builder', '实现修复', baseDir);

    assert.match(text, /\[当前进度 now\/builder\.md\]/);
    assert.match(text, /PRIVATE builder progress/);
    assert.doesNotMatch(text, /SHARED team progress/);
  });

  it('includes shared context only when explicitly requested', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-team-dispatch-'));
    const nowDir = path.join(baseDir, 'memory', 'now');
    fs.mkdirSync(nowDir, { recursive: true });
    fs.writeFileSync(path.join(nowDir, 'builder.md'), 'PRIVATE builder progress', 'utf8');
    fs.writeFileSync(path.join(nowDir, 'shared.md'), 'SHARED team progress', 'utf8');

    const text = buildEnrichedPrompt('builder', '实现修复', baseDir, { includeShared: true });

    assert.match(text, /\[当前进度 now\/builder\.md\]/);
    assert.match(text, /\[共享进度 now\/shared\.md\]/);
    assert.match(text, /SHARED team progress/);
  });

  it('writes target-only now context for direct dispatch and shared state only for TeamTask', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-team-dispatch-'));
    const config = {
      projects: {
        builder: { name: 'Builder', icon: '🛠' },
      },
    };

    updateDispatchContextFiles({
      baseDir,
      fullMsg: {
        id: 'd_direct_001',
        from: '_claude_session',
        payload: { prompt: '直接修一下', title: '直接修一下' },
      },
      targetProject: 'builder',
      config,
      envelope: null,
    });

    const targetNow = fs.readFileSync(path.join(baseDir, 'memory', 'now', 'builder.md'), 'utf8');
    assert.match(targetNow, /更新者.*👤 用户/);
    assert.equal(fs.existsSync(path.join(baseDir, 'memory', 'now', 'shared.md')), false);

    updateDispatchContextFiles({
      baseDir,
      fullMsg: {
        id: 'd_team_001',
        source_sender_key: 'user',
        payload: { prompt: '团队协作修一下', title: '团队协作修一下' },
      },
      targetProject: 'builder',
      config,
      envelope: {
        task_id: 't_team_001',
        scope_id: 'epic_auth',
        task_kind: 'team',
      },
    });

    const sharedNow = fs.readFileSync(path.join(baseDir, 'memory', 'now', 'shared.md'), 'utf8');
    const tasksBoard = fs.readFileSync(path.join(baseDir, 'memory', 'shared', 'tasks.md'), 'utf8');
    assert.match(sharedNow, /TeamTask.*t_team_001/);
    assert.match(tasksBoard, /Builder/);
  });

  it('normalizes placeholder dispatch sources to user actor', () => {
    assert.deepEqual(resolveDispatchActor('_claude_session', {}), {
      key: 'user',
      name: '用户',
      icon: '👤',
      isUser: true,
    });
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createSessionStore } = require('./daemon-session-store');

describe('daemon-session-store codex metadata', () => {
  it('preserves codex sandbox profile in engine slot', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
    const store = createSessionStore({
      fs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: () => {},
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    const created = store.createSession('chat-1', tempHome, 'Jarvis', 'codex', {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });

    assert.equal(created.engine, 'codex');
    assert.equal(created.permissionMode, 'danger-full-access');
    assert.equal(created.sandboxMode, 'danger-full-access');
    assert.equal(created.approvalPolicy, 'never');
    assert.equal(store.getSessionForEngine('chat-1', 'codex').permissionMode, 'danger-full-access');
    assert.equal(store.getSessionForEngine('chat-1', 'codex').runtimeSessionObserved, false);
  });

  it('restores reply-bound codex sessions into engine-aware state without dropping permission metadata', () => {
    const state = {
      sessions: {
        'chat-1': {
          cwd: '/tmp/old',
          engines: {
            claude: { id: 'claude-1', started: true },
          },
        },
      },
    };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
    const store = createSessionStore({
      fs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: () => {},
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    const restored = store.restoreSessionFromReply('chat-1', {
      id: 'codex-2',
      cwd: tempHome,
      engine: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });

    assert.equal(restored.engine, 'codex');
    assert.equal(restored.id, 'codex-2');
    assert.equal(restored.sandboxMode, 'danger-full-access');
    assert.equal(restored.approvalPolicy, 'never');
    assert.equal(restored.runtimeSessionObserved, true);
    assert.equal(store.getSessionForEngine('chat-1', 'claude').id, 'claude-1');
    assert.equal(state.sessions['chat-1'].engines.codex.permissionMode, 'danger-full-access');
    assert.equal(state.sessions['chat-1'].id, undefined);
  });

  it('keeps fresh codex sessions non-resumable until runtime reports a real thread id', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
    const store = createSessionStore({
      fs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: () => {},
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    store.createSession('chat-1', tempHome, 'Jarvis', 'codex', {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
    store.markSessionStarted('chat-1', 'codex');

    const beforeObserved = store.getSessionForEngine('chat-1', 'codex');
    assert.equal(beforeObserved.started, false);
    assert.equal(beforeObserved.runtimeSessionObserved, false);

    store.restoreSessionFromReply('chat-1', {
      id: 'codex-thread-1',
      cwd: tempHome,
      engine: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
    store.markSessionStarted('chat-1', 'codex');

    const afterObserved = store.getSessionForEngine('chat-1', 'codex');
    assert.equal(afterObserved.started, true);
    assert.equal(afterObserved.runtimeSessionObserved, true);
  });

  it('treats non-claude JSONL sessions as invalid for claude resume', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
    const projectDir = path.join(tempHome, '.claude', 'projects', 'project-a');
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = 'session-non-claude';
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ message: { model: 'gpt-5', cwd: tempHome } })}\n`,
      'utf8'
    );

    const store = createSessionStore({
      fs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: () => {},
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    assert.equal(store.isEngineSessionValid('claude', sessionId, tempHome), false);
  });

  it('lists codex sessions and filters by engine', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));

    const claudeProjectDir = path.join(tempHome, '.claude', 'projects', 'project-a');
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeProjectDir, 'claude-session.jsonl'),
      `${JSON.stringify({ type: 'user', userType: 'external', message: { content: 'Claude first prompt' }, cwd: '/tmp/claude-proj' })}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(claudeProjectDir, 'sessions-index.json'),
      JSON.stringify({
        entries: [{
          sessionId: 'claude-session',
          projectPath: '/tmp/shared-proj',
          messageCount: 2,
          modified: new Date('2026-03-10T00:00:00.000Z').toISOString(),
        }],
      }),
      'utf8'
    );

    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        cli_version TEXT NOT NULL DEFAULT '',
        first_user_message TEXT NOT NULL DEFAULT '',
        agent_nickname TEXT,
        agent_role TEXT,
        memory_mode TEXT NOT NULL DEFAULT 'enabled'
      );
    `);
    db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version,
        first_user_message, memory_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'codex-session',
      '',
      1773214000,
      1773216000,
      'cli',
      'openai',
      '/tmp/shared-proj',
      'Codex title',
      '{"type":"danger-full-access"}',
      'never',
      123,
      1,
      0,
      '1.0.0',
      'Codex first prompt',
      'enabled'
    );
    db.close();

    const store = createSessionStore({
      fs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: () => {},
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    const codexSessions = store.listRecentSessions(10, '/tmp/shared-proj', 'codex');
    assert.equal(codexSessions.length, 1);
    assert.equal(codexSessions[0].sessionId, 'codex-session');
    assert.equal(codexSessions[0].engine, 'codex');
    assert.equal(codexSessions[0].customTitle, 'Codex title');

    const claudeSessions = store.listRecentSessions(10, '/tmp/shared-proj', 'claude');
    assert.equal(claudeSessions.length, 1);
    assert.equal(claudeSessions[0].sessionId, 'claude-session');
    assert.equal(claudeSessions[0].engine, 'claude');
  });
});

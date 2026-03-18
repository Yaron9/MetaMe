'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createSessionStore } = require('./daemon-session-store');

function writeCodexRollout(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

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

  it('prefers the current logical codex slot over stale historical reply thread metadata', () => {
    const businessCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-business-'));
    const state = {
      sessions: {
        '_bound_business': {
          cwd: businessCwd,
          engines: {
            codex: {
              id: 'codex-current',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
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

    const restored = store.restoreSessionFromReply('oc_group_1', {
      id: 'codex-stale-readonly',
      cwd: '/tmp/readonly',
      engine: 'codex',
      logicalChatId: '_bound_business',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      permissionMode: 'read-only',
    });

    assert.equal(restored.id, 'codex-current');
    assert.equal(restored.cwd, path.resolve(businessCwd));
    assert.equal(restored.permissionMode, 'danger-full-access');
    assert.equal(state.sessions['_bound_business'].engines.codex.id, 'codex-current');
    assert.equal(state.sessions['oc_group_1'].engines.codex.id, 'codex-current');
  });

  it('restores reply-bound team member sessions onto the logical virtual chat id', () => {
    const memberCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-member-'));
    const state = {
      sessions: {
        '_agent_bing': {
          cwd: memberCwd,
          engines: {
            codex: {
              id: 'bing-current',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
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

    const restored = store.restoreSessionFromReply('oc_team_group', {
      id: 'bing-stale',
      cwd: '/tmp/stale-bing',
      engine: 'codex',
      logicalChatId: '_agent_bing',
      agentKey: 'bing',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      permissionMode: 'read-only',
    });

    assert.equal(restored.id, 'bing-current');
    assert.equal(restored.cwd, path.resolve(memberCwd));
    assert.equal(state.sessions['_agent_bing'].engines.codex.id, 'bing-current');
    assert.equal(state.sessions['oc_team_group'].engines.codex.id, 'bing-current');
  });

  it('restores weak reply mappings onto the current logical team session even without a historical thread id', () => {
    const memberCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-member-'));
    const state = {
      sessions: {
        '_agent_jia': {
          cwd: memberCwd,
          engines: {
            codex: {
              id: 'jia-current',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
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

    const restored = store.restoreSessionFromReply('oc_team_group', {
      cwd: memberCwd,
      engine: 'codex',
      logicalChatId: '_agent_jia',
      agentKey: 'jia',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      permissionMode: 'danger-full-access',
    });

    assert.equal(restored.id, 'jia-current');
    assert.equal(restored.cwd, path.resolve(memberCwd));
    assert.equal(state.sessions['_agent_jia'].engines.codex.id, 'jia-current');
    assert.equal(state.sessions['oc_team_group'].engines.codex.id, 'jia-current');
    assert.equal(state.sessions['oc_team_group'].engines.codex.runtimeSessionObserved, true);
  });

  it('renders synthetic logical sessions without historical timestamps', () => {
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
      formatRelativeTime: () => 'just now',
      cpExtractTimestamp: () => null,
    });

    const synthetic = {
      sessionId: 'codex-current-thread',
      projectPath: tempHome,
      engine: 'codex',
      customTitle: '当前会话',
      summary: '优先续接当前智能体会话',
    };

    assert.match(store.sessionLabel(synthetic), /当前会话/);
    assert.match(store.sessionRichLabel(synthetic, 1, {}), /当前会话/);
    const elements = store.buildSessionCardElements([synthetic]);
    assert.equal(Array.isArray(elements), true);
    assert.equal(elements.length, 2);
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
    const rolloutPath = path.join(codexDir, 'sessions', '2026', '03', '10', 'codex-session.jsonl');
    writeCodexRollout(rolloutPath, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Codex first prompt\n\nSystem hints (internal, do not mention to user):\nignore' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Codex last reply' },
      },
    ]);
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
      rolloutPath,
      1773214000,
      1773216000,
      'exec',
      'openai',
      '/tmp/shared-proj',
      'Codex title',
      '{"type":"danger-full-access"}',
      'never',
      123,
      0,
      0,
      '1.0.0',
      'Codex first prompt\n\nSystem hints (internal, do not mention to user):\nignore',
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
    assert.equal(codexSessions[0].firstPrompt, 'Codex first prompt');
    assert.equal(codexSessions[0].lastUser, 'Codex first prompt');
    assert.deepEqual(store.getSessionRecentContext('codex-session'), {
      lastUser: 'Codex first prompt',
      lastAssistant: 'Codex last reply',
    });

    const claudeSessions = store.listRecentSessions(10, '/tmp/shared-proj', 'claude');
    assert.equal(claudeSessions.length, 1);
    assert.equal(claudeSessions[0].sessionId, 'claude-session');
    assert.equal(claudeSessions[0].engine, 'claude');
    assert.deepEqual(store.getCodexSessionSandboxProfile('codex-session'), {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      permissionMode: 'danger-full-access',
    });
  });

  it('skips internal codex exec threads when listing resumable sessions', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
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
      'codex-internal',
      '',
      1773214000,
      1773216000,
      'exec',
      'openai',
      '/tmp/shared-proj',
      'You are a MetaMe cognitive profile distiller. Extract traits only.',
      '{"type":"danger-full-access"}',
      'never',
      123,
      0,
      0,
      '1.0.0',
      'You are a MetaMe cognitive profile distiller. Extract traits only.',
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
    assert.equal(codexSessions.length, 0);
  });

  it('keeps real codex exec user sessions even when prompt starts with "You are"', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const rolloutPath = path.join(codexDir, 'sessions', '2026', '03', '11', 'codex-user-like.jsonl');
    writeCodexRollout(rolloutPath, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'You are wrong, check the resume logic again.' }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'agent_message', message: '中间状态，不该作为最终回复' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '最终回复：resume 逻辑已重新检查。' }],
        },
      },
    ]);
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
      'codex-user-like',
      rolloutPath,
      1773214000,
      1773216000,
      'exec',
      'openai',
      '/tmp/shared-proj',
      'You are wrong, check the resume logic again.',
      '{"type":"danger-full-access"}',
      'never',
      123,
      0,
      0,
      '1.0.0',
      'You are wrong, check the resume logic again.',
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
    assert.equal(codexSessions[0].sessionId, 'codex-user-like');
    assert.deepEqual(store.getSessionRecentContext('codex-user-like'), {
      lastUser: 'You are wrong, check the resume logic again.',
      lastAssistant: '最终回复：resume 逻辑已重新检查。',
    });
  });

  it('keeps healthy Claude sessions visible when one project directory scan fails', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));
    const goodProjectDir = path.join(tempHome, '.claude', 'projects', 'good-project');
    const badProjectDir = path.join(tempHome, '.claude', 'projects', 'bad-project');
    fs.mkdirSync(goodProjectDir, { recursive: true });
    fs.mkdirSync(badProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(goodProjectDir, 'good-session.jsonl'),
      `${JSON.stringify({ type: 'user', userType: 'external', message: { content: 'Keep this session visible' } })}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(goodProjectDir, 'sessions-index.json'),
      JSON.stringify({
        entries: [{
          sessionId: 'good-session',
          projectPath: '/tmp/bound-project',
          messageCount: 2,
          modified: new Date('2026-03-12T00:00:00.000Z').toISOString(),
        }],
      }),
      'utf8'
    );

    const logs = [];
    const noisyFs = {
      ...fs,
      readdirSync(target, options) {
        if (target === badProjectDir) {
          throw new Error('simulated bad-project readdir failure');
        }
        return fs.readdirSync(target, options);
      },
    };

    const store = createSessionStore({
      fs: noisyFs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: (level, message) => logs.push({ level, message }),
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    const sessions = store.listRecentSessions(10, '/tmp/bound-project', 'claude');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'good-session');
    assert.equal(logs.some(entry => entry.message.includes('scanClaudeSessions project') && entry.message.includes('bad-project')), true);
  });

  it('keeps Claude sessions visible when Codex DB scan fails', () => {
    const state = { sessions: {} };
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-session-store-'));

    const claudeProjectDir = path.join(tempHome, '.claude', 'projects', 'project-a');
    fs.mkdirSync(claudeProjectDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeProjectDir, 'claude-session.jsonl'),
      `${JSON.stringify({ type: 'user', userType: 'external', message: { content: 'Claude survives codex failure' } })}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(claudeProjectDir, 'sessions-index.json'),
      JSON.stringify({
        entries: [{
          sessionId: 'claude-session',
          projectPath: '/tmp/shared-proj',
          messageCount: 1,
          modified: new Date('2026-03-13T00:00:00.000Z').toISOString(),
        }],
      }),
      'utf8'
    );

    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'state_5.sqlite'), 'not-a-real-sqlite-db', 'utf8');

    const logs = [];
    const store = createSessionStore({
      fs,
      path,
      HOME: tempHome,
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
      },
      log: (level, message) => logs.push({ level, message }),
      formatRelativeTime: () => 'now',
      cpExtractTimestamp: () => null,
    });

    const sessions = store.listRecentSessions(10, '/tmp/shared-proj', 'claude');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'claude-session');
    assert.equal(logs.some(entry => entry.message.includes('scanCodexSessions') && entry.message.includes('state_5.sqlite')), true);
  });
});

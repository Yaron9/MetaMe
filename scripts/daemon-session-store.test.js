'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionStore } = require('./daemon-session-store');

describe('daemon-session-store codex metadata', () => {
  it('preserves codex permission mode in engine slot', () => {
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

    const created = store.createSession('chat-1', tempHome, 'Jarvis', 'codex', { permissionMode: 'writable' });

    assert.equal(created.engine, 'codex');
    assert.equal(created.permissionMode, 'writable');
    assert.equal(store.getSessionForEngine('chat-1', 'codex').permissionMode, 'writable');
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
});

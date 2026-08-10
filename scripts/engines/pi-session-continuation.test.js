'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../daemon-session-store');
const { createDefaultEngineRegistry } = require('./engine-registry');
const { createPiCliAdapter } = require('./pi-cli-adapter');

function makeStore(home, loadState, saveState) {
  return createSessionStore({
    fs,
    path,
    HOME: home,
    loadState,
    saveState,
    log: () => {},
    formatRelativeTime: () => 'now',
    cpExtractTimestamp: () => null,
  });
}

test('Pi native session slot survives a daemon restart and resumes by session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-pi-restart-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  let persisted = { sessions: {} };
  const saveState = next => {
    persisted = structuredClone(next);
  };

  const beforeRestart = makeStore(home, () => persisted, saveState);
  const claude = beforeRestart.createSession('chat-pi', project, '', 'claude');
  const created = beforeRestart.createSession('chat-pi', project, '', 'pi');
  assert.equal(created.engine, 'pi');
  assert.equal(created.started, false);

  beforeRestart.restoreSessionFromReply('chat-pi', {
    id: 'pi-native-session',
    cwd: project,
    engine: 'pi',
  });

  // A fresh store instance models the daemon having restarted after the native
  // session observation was persisted.
  const afterRestart = makeStore(home, () => persisted, saveState);
  const restored = afterRestart.getSessionForEngine('chat-pi', 'pi');
  assert.deepEqual(restored, {
    cwd: project,
    engine: 'pi',
    id: 'pi-native-session',
    started: true,
  });
  assert.equal(afterRestart.getSessionForEngine('chat-pi', 'claude').id, claude.id);

  const runtime = createPiCliAdapter({
    binary: '/opt/test/pi',
    sessionDir: path.join(home, 'pi-sessions'),
  });
  const invocation = runtime.buildInvocation({
    input: 'continue after restart',
    cwd: restored.cwd,
    session: restored,
  });
  assert.deepEqual(invocation.args.slice(-2), ['--session-id', 'pi-native-session']);
});

test('disabling or removing Pi leaves native session files untouched and blocks new lookup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-pi-disable-'));
  const sessionDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const nativePath = path.join(sessionDir, 'pi-native-session.jsonl');
  fs.writeFileSync(nativePath, '{"type":"session","version":3,"id":"pi-native-session"}\n', 'utf8');

  const registry = createDefaultEngineRegistry({
    pi: { home, binary: '/opt/test/pi', sessionDir },
  });
  assert.equal(registry.lookup('pi').descriptor.capabilities.sessionSource.state, 'verified');
  assert.equal(registry.disable('pi'), true);
  assert.equal(registry.lookup('pi', { includeDisabled: false }), null);
  assert.equal(registry.resolve('pi').reason, 'engine_disabled');
  assert.equal(fs.existsSync(nativePath), true);

  assert.equal(registry.remove('pi'), true);
  assert.equal(registry.lookup('pi'), null);
  assert.deepEqual(registry.retiredIds(), ['pi']);
  assert.equal(fs.existsSync(nativePath), true);
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminCommandHandler } = require('./daemon-admin-commands');

function createHandler(getAllTasksImpl) {
  return createAdminCommandHandler({
    fs: require('fs'),
    yaml: { load: () => ({}), dump: () => '' },
    execSync: () => '',
    BRAIN_FILE: '/tmp/brain.yaml',
    CONFIG_FILE: '/tmp/config.yaml',
    DISPATCH_LOG: '/tmp/dispatch.log',
    providerMod: null,
    loadConfig: () => ({}),
    backupConfig: () => {},
    writeConfigSafe: () => {},
    restoreConfig: () => false,
    getSession: () => null,
    getAllTasks: getAllTasksImpl,
    dispatchTask: () => ({ success: true }),
    log: () => {},
    skillEvolution: null,
    taskBoard: null,
    taskEnvelope: null,
  });
}

describe('daemon-admin-commands /tasks', () => {
  it('renders interval and fixed-time schedules for mobile task list', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(() => ({
      general: [
        { name: 'memory-extract', interval: '4h', enabled: true },
      ],
      project: [
        {
          name: 'morning-brief',
          at: '09:00',
          days: 'weekdays',
          enabled: true,
          _project: { key: 'writer', icon: '✍️', name: 'Writer' },
        },
      ],
    }));

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-1',
      text: '/tasks',
      config: {},
      state: {
        tasks: {
          'memory-extract': { status: 'success' },
          'morning-brief': { status: 'never_run' },
        },
      },
    });

    assert.equal(res.handled, true);
    assert.equal(sent.length, 1);
    const body = sent[0];
    assert.match(body, /memory-extract \(every 4h\) success/);
    assert.match(body, /morning-brief \(at 09:00 weekdays\) never_run/);
  });
});

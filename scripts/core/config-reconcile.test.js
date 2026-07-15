'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileDaemonConfig } = require('./config-reconcile');

describe('daemon config reconciliation', () => {
  it('adds missing embedding config and task without changing unrelated settings', () => {
    const original = {
      daemon: { model: 'sonnet' },
      heartbeat: { tasks: [{ name: 'custom', enabled: false }] },
      feishu: { token: 'untouched' },
    };
    const result = reconcileDaemonConfig(original);
    assert.deepEqual(result.config.daemon.embedding, {
      backend: 'ollama', model: 'bge-m3', dimensions: 1024,
    });
    assert.equal(result.config.heartbeat.tasks[0].name, 'custom');
    assert.equal(result.config.heartbeat.tasks[1].name, 'embedding-index');
    assert.equal(result.config.feishu.token, 'untouched');
    assert.equal(original.daemon.embedding, undefined, 'input must not be mutated');
  });

  it('preserves an existing task schedule and enabled state', () => {
    const existing = {
      daemon: { embedding: { backend: 'openai', model: 'custom', dimensions: 256 } },
      heartbeat: {
        tasks: [{
          name: 'embedding-index', command: 'custom-worker', interval: '2h', enabled: false,
        }],
      },
    };
    const result = reconcileDaemonConfig(existing);
    assert.equal(result.config.heartbeat.tasks.length, 1);
    assert.equal(result.config.heartbeat.tasks[0].command, 'custom-worker');
    assert.equal(result.config.heartbeat.tasks[0].interval, '2h');
    assert.equal(result.config.heartbeat.tasks[0].enabled, false);
    assert.deepEqual(result.changes, []);
  });

  it('replaces only the recognized legacy wiki-sync inline command', () => {
    const legacy = {
      heartbeat: { tasks: [{
        name: 'wiki-sync',
        command: "node -e \"require('x').runWikiReflect()\"",
        at: '04:00',
        enabled: true,
      }] },
    };
    const result = reconcileDaemonConfig(legacy);
    const task = result.config.heartbeat.tasks.find(item => item.name === 'wiki-sync');
    assert.equal(task.command, 'node ~/.metame/wiki-reflect.js');
    assert.equal(task.at, '04:00');
    assert.equal(task.enabled, true);
  });
});

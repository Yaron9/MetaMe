'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const bridgesPath = require.resolve('./daemon-bridges.js');
const weixinBridgePath = require.resolve('./daemon-weixin-bridge.js');
const originalBridges = require.cache[bridgesPath];
const originalWeixinBridge = require.cache[weixinBridgePath];

describe('daemon weixin wiring', () => {
  afterEach(() => {
    if (originalBridges) require.cache[bridgesPath] = originalBridges;
    else delete require.cache[bridgesPath];
    if (originalWeixinBridge) require.cache[weixinBridgePath] = originalWeixinBridge;
    else delete require.cache[weixinBridgePath];
  });

  it('createBridgeStarter exposes startWeixinBridge and delegates to daemon-weixin-bridge', async () => {
    let receivedDeps = null;
    let receivedStart = null;

    require.cache[weixinBridgePath] = {
      id: weixinBridgePath,
      filename: weixinBridgePath,
      loaded: true,
      exports: {
        createWeixinBridge(deps) {
          receivedDeps = deps;
          return {
            startWeixinBridge: async (config, executeTaskByName) => {
              receivedStart = { config, executeTaskByName };
              return { stop() {}, bot: { sendMessage: async () => ({ message_id: 1 }) } };
            },
          };
        },
      },
    };

    delete require.cache[bridgesPath];
    const { createBridgeStarter } = require('./daemon-bridges.js');
    const deps = {
      fs: require('fs'),
      path: require('path'),
      HOME: '/tmp/metame-home',
      log: () => {},
      sleep: async () => {},
      loadConfig: () => ({}),
      loadState: () => ({}),
      saveState: () => {},
      getSession: () => null,
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline: { processMessage: async () => {} },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    };
    const starter = createBridgeStarter(deps);
    assert.equal(typeof starter.startWeixinBridge, 'function');

    const config = { weixin: { enabled: true } };
    const executeTaskByName = async () => ({ success: true });
    await starter.startWeixinBridge(config, executeTaskByName);

    assert.ok(receivedDeps, 'createWeixinBridge should receive deps');
    assert.equal(receivedDeps.HOME, '/tmp/metame-home');
    assert.equal(typeof receivedDeps.loadConfig, 'function');
    assert.equal(receivedDeps.pipeline, deps.pipeline);
    assert.deepEqual(receivedStart, { config, executeTaskByName });
  });
});

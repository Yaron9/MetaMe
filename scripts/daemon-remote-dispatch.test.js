'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeRemoteDispatchConfig,
  buildPairHello,
  decodePairPacket,
  learnPairHello,
  resolvePeerSecret,
  encodePacket,
  decodePacket,
  verifyPacket,
  getRemoteDispatchStatus,
} = require('./daemon-remote-dispatch');

const tmpDirs = [];

function mkHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-rd-'));
  tmpDirs.push(dir);
  return dir;
}

function makeConfig(self) {
  return {
    feishu: {
      remote_dispatch: {
        enabled: true,
        self,
        chat_id: 'oc_relay_test',
        secret: '',
      },
    },
  };
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('daemon-remote-dispatch auto pairing', () => {
  it('accepts remote dispatch config without explicit secret', () => {
    const rd = normalizeRemoteDispatchConfig(makeConfig('mac'));
    assert.deepEqual(rd, { selfPeer: 'mac', chatId: 'oc_relay_test', secret: null });
  });

  it('derives matching peer secrets after hello exchange', () => {
    const macHome = mkHome();
    const winHome = mkHome();
    const macConfig = makeConfig('mac');
    const winConfig = makeConfig('windows');

    const macHello = decodePairPacket(buildPairHello(macConfig, { force: true, homeDir: macHome }));
    const winHello = decodePairPacket(buildPairHello(winConfig, { force: true, homeDir: winHome }));

    const learnedOnWin = learnPairHello(winConfig, macHello, winHome);
    const learnedOnMac = learnPairHello(macConfig, winHello, macHome);

    assert.equal(learnedOnWin.peer, 'mac');
    assert.equal(learnedOnMac.peer, 'windows');

    const macSecret = resolvePeerSecret(macConfig, 'windows', macHome);
    const winSecret = resolvePeerSecret(winConfig, 'mac', winHome);
    assert.ok(macSecret);
    assert.equal(macSecret, winSecret);

    const encoded = encodePacket({
      v: 1,
      id: 'pkt_1',
      ts: '2026-03-12T00:00:00.000Z',
      type: 'task',
      from_peer: 'mac',
      to_peer: 'windows',
      target_project: 'metame',
      prompt: 'hello',
    }, macSecret);
    const decoded = decodePacket(encoded);
    assert.equal(verifyPacket(decoded, winSecret), true);
  });

  it('reports auto-paired peers in status output', () => {
    const macHome = mkHome();
    const winHome = mkHome();
    const macConfig = makeConfig('mac');
    const winConfig = makeConfig('windows');

    learnPairHello(winConfig, decodePairPacket(buildPairHello(macConfig, { force: true, homeDir: macHome })), winHome);
    learnPairHello(macConfig, decodePairPacket(buildPairHello(winConfig, { force: true, homeDir: winHome })), macHome);

    const status = getRemoteDispatchStatus(macConfig, macHome);
    assert.equal(status.mode, 'auto');
    assert.equal(status.pairedPeers.length, 1);
    assert.equal(status.pairedPeers[0].peer, 'windows');
  });
});

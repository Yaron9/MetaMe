'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRemoteDispatchConfig,
  deriveSecretFromPairCode,
  generatePairCode,
  isValidPairCode,
  encodePacket,
  decodePacket,
  verifyPacket,
  getRemoteDispatchStatus,
} = require('./daemon-remote-dispatch');

describe('daemon-remote-dispatch pair code', () => {
  it('requires explicit secret in runtime config', () => {
    assert.equal(normalizeRemoteDispatchConfig({
      feishu: { remote_dispatch: { enabled: true, self: 'mac', chat_id: 'oc_test', secret: '' } },
    }), null);
  });

  it('generates 6-digit numeric codes', () => {
    const code = generatePairCode();
    assert.equal(isValidPairCode(code), true);
    assert.equal(code.length, 6);
  });

  it('derives the same secret from the same pair code and relay chat', () => {
    const a = deriveSecretFromPairCode('123456', 'oc_relay_xxx');
    const b = deriveSecretFromPairCode('123456', 'oc_relay_xxx');
    const c = deriveSecretFromPairCode('123456', 'oc_other');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it('signs and verifies packets with the derived secret', () => {
    const secret = deriveSecretFromPairCode('654321', 'oc_relay_xxx');
    const encoded = encodePacket({
      v: 1,
      id: 'pkt_1',
      ts: '2026-03-12T00:00:00.000Z',
      type: 'task',
      from_peer: 'mac',
      to_peer: 'windows',
      target_project: 'metame',
      prompt: 'hello',
    }, secret);
    const decoded = decodePacket(encoded);
    assert.equal(verifyPacket(decoded, secret), true);
  });

  it('reports pair-code status when configured', () => {
    const status = getRemoteDispatchStatus({
      feishu: { remote_dispatch: { enabled: true, self: 'mac', chat_id: 'oc_test', secret: 'abc' } },
    });
    assert.deepEqual(status, {
      selfPeer: 'mac',
      chatId: 'oc_test',
      mode: 'pair-code',
      hasSecret: true,
    });
  });
});

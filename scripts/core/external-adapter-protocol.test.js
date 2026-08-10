'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXTERNAL_ADAPTER_PROTOCOL_VERSION,
  assertProtocolRecord,
  createStrictLfFramer,
  encodeProtocolRecord,
  parseProtocolLine,
  redactDiagnostic,
  validateProtocolRecord,
} = require('./external-adapter-protocol');

function initialize(correlationId = 'init-1') {
  return {
    type: 'initialize',
    protocolVersion: EXTERNAL_ADAPTER_PROTOCOL_VERSION,
    engineId: 'fixture-external',
    correlationId,
  };
}

test('external protocol schema is strict and closes record envelopes', () => {
  assert.equal(validateProtocolRecord(initialize()).valid, true);
  assert.equal(validateProtocolRecord({ ...initialize(), unexpected: true }).valid, false);
  assert.equal(validateProtocolRecord({ type: 'unknown', correlationId: 'x' }).valid, false);
  assert.equal(validateProtocolRecord({ type: 'cancel', correlationId: 'x' }).valid, false);
  assert.equal(validateProtocolRecord({
    type: 'response', operation: 'probe', correlationId: 'x', ok: true,
  }).valid, false);
  assert.throws(() => assertProtocolRecord({ ...initialize(), unexpected: true }), /PROTOCOL_RECORD_INVALID/);
});

test('strict-LF framer preserves UTF-8 split boundaries and rejects CRLF', () => {
  const first = encodeProtocolRecord({ ...initialize('utf8-1') });
  const split = Buffer.from(first, 'utf8');
  const marker = split.indexOf(Buffer.from('fixture-external'));
  const emojiRecord = encodeProtocolRecord({
    type: 'event',
    operation: 'run',
    correlationId: 'utf8-2',
    event: { type: 'message_delta', text: '你好 🌏' },
  });
  const framer = createStrictLfFramer();
  assert.deepEqual(framer.feed(split.subarray(0, marker + 4)), []);
  assert.deepEqual(framer.feed(split.subarray(marker + 4)), [initialize('utf8-1')]);
  const emojiBytes = Buffer.from(emojiRecord, 'utf8');
  const emojiIndex = emojiBytes.indexOf(Buffer.from('你好'));
  assert.deepEqual(framer.feed(emojiBytes.subarray(0, emojiIndex + 2)), []);
  assert.deepEqual(framer.feed(emojiBytes.subarray(emojiIndex + 2)), [{
    type: 'event', operation: 'run', correlationId: 'utf8-2',
    event: { type: 'message_delta', text: '你好 🌏' },
  }]);
  assert.throws(() => parseProtocolLine(`${JSON.stringify(initialize())}\r`), /PROTOCOL_LINE_NOT_STRICT_LF/);
});

test('record and diagnostic limits are bounded and redacted', () => {
  assert.throws(() => encodeProtocolRecord({
    type: 'run', correlationId: 'run-1', input: 'x'.repeat(100),
  }, { maxRecordBytes: 64 }), /PROTOCOL_RECORD_TOO_LARGE|PROTOCOL_RECORD_INVALID/);
  const diagnostic = redactDiagnostic({ token: 'secret-value', nested: { password: 'pw', text: 'ok' } });
  assert.equal(diagnostic.token, '[REDACTED]');
  assert.equal(diagnostic.nested.password, '[REDACTED]');
  assert.equal(diagnostic.nested.text, 'ok');
});

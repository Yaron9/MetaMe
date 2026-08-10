'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCanonicalSessionEvent,
  normalizeCanonicalSessionEvents,
} = require('./canonical-session-event');

const context = {
  engineId: 'fixture-agent',
  nativeSessionId: 'native-1',
  sourceRevision: 'rev-a',
};

test('canonical event normalizes evidence structure without memory/truth fields', () => {
  const event = normalizeCanonicalSessionEvent({
    role: 'model',
    type: 'text',
    text: '  answer  ',
    timestamp: '2026-08-10T00:00:00+08:00',
    sequence: 3,
    truth: true,
    confidence: 1,
  }, context);

  assert.equal(event.actor, 'assistant');
  assert.equal(event.kind, 'message');
  assert.equal(event.timestamp, '2026-08-09T16:00:00.000Z');
  assert.equal(event.text, '  answer  ');
  assert.equal('truth' in event, false);
  assert.equal('confidence' in event, false);
  assert.match(event.eventId, /^cse_[a-f0-9]{32}$/);
});

test('event IDs are deterministic for replayed records', () => {
  const input = { actor: 'user', kind: 'message', text: 'same', sequence: 0 };
  const first = normalizeCanonicalSessionEvent(input, context);
  const second = normalizeCanonicalSessionEvent(input, context);
  assert.equal(first.eventId, second.eventId);
  assert.deepEqual(first, second);
});

test('tool evidence preserves structural outcome and provenance only', () => {
  const event = normalizeCanonicalSessionEvent({
    actor: 'function',
    kind: 'result',
    toolName: 'shell',
    outcome: { exitCode: 0 },
    provenance: { nativeEventId: 'n-2', locator: { offset: 10 } },
    sequence: 4,
  }, context);
  assert.equal(event.actor, 'tool');
  assert.equal(event.kind, 'tool_result');
  assert.equal(event.tool, 'shell');
  assert.deepEqual(event.outcome, { exitCode: 0 });
  assert.deepEqual(event.provenance, { nativeEventId: 'n-2', locator: { offset: 10 } });
});

test('canonical event validation rejects unsupported actor, kind, and sequence', () => {
  assert.throws(() => normalizeCanonicalSessionEvent({ actor: 'critic', kind: 'message', sequence: 0 }, context), /canonical_session_event_actor_invalid/);
  assert.throws(() => normalizeCanonicalSessionEvent({ actor: 'user', kind: 'claim', sequence: 0 }, context), /canonical_session_event_kind_invalid/);
  assert.throws(() => normalizeCanonicalSessionEvent({ actor: 'user', kind: 'message', sequence: -1 }, context), /canonical_session_event_sequence_invalid/);
});

test('event arrays receive deterministic fallback sequence values', () => {
  const events = normalizeCanonicalSessionEvents([
    { actor: 'user', kind: 'message', text: 'one' },
    { actor: 'assistant', kind: 'message', text: 'two' },
  ], context);
  assert.deepEqual(events.map(event => event.sequence), [0, 1]);
});

#!/usr/bin/env node
'use strict';

/*
 * Deterministic external adapter used by protocol conformance tests.  It is a
 * real child process: stdout is protocol-only and human diagnostics (when
 * requested by a test) go to stderr.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  EXTERNAL_ADAPTER_OPERATIONS,
  EXTERNAL_ADAPTER_PROTOCOL_VERSION,
  createStrictLfFramer,
  encodeProtocolRecord,
} = require('../../core/external-adapter-protocol');

const ENGINE_ID = process.env.METAME_FIXTURE_ENGINE_ID || 'fixture-external';
const ADAPTER_PROTOCOL_VERSION = Number(process.env.METAME_FIXTURE_PROTOCOL_VERSION || EXTERNAL_ADAPTER_PROTOCOL_VERSION);
const SESSION_FILE = process.env.METAME_FIXTURE_SESSION_FILE
  || path.join(process.cwd(), '.metame-external-session.jsonl');
const unsupported = new Set(String(process.env.METAME_FIXTURE_UNSUPPORTED || '')
  .split(',').map(value => value.trim()).filter(Boolean));
const capabilities = Object.freeze(Object.fromEntries(
  EXTERNAL_ADAPTER_OPERATIONS.map(operation => [operation, !unsupported.has(operation)]),
));
const framer = createStrictLfFramer();
let runCount = 0;
let activeRun = null;
let closing = false;

function send(record) {
  if (closing && record.type !== 'response') return;
  process.stdout.write(encodeProtocolRecord(record));
}

function sendResponse(request, result) {
  send({
    type: 'response',
    operation: request.type,
    correlationId: request.correlationId,
    ok: true,
    result,
  });
}

function sendError(request, code, message = code, operation = request && request.type) {
  send({
    type: 'error',
    ...(operation ? { operation } : {}),
    correlationId: request && request.correlationId ? request.correlationId : 'fixture-error',
    error: { code, message: String(message).slice(0, 1024) },
  });
}

function sourceEvents() {
  try {
    const text = fs.readFileSync(SESSION_FILE, 'utf8');
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function sourceRevision(events) {
  return `fixture_${crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex')}`;
}

function sessionIdFor(request) {
  return String(request.nativeSessionId || request.runId || `fixture-session-${runCount + 1}`).slice(0, 256);
}

function appendSession(input, request) {
  const existing = sourceEvents();
  const sessionId = sessionIdFor(request);
  const now = new Date(0).toISOString();
  const next = existing.concat([
    {
      nativeSessionId: sessionId,
      actor: 'user',
      kind: 'message',
      text: String(input),
      sequence: existing.length,
      timestamp: now,
    },
    {
      nativeSessionId: sessionId,
      actor: 'assistant',
      kind: 'message',
      text: `fixture:${String(input).slice(0, 256)}`,
      sequence: existing.length + 1,
      timestamp: now,
    },
  ]);
  fs.writeFileSync(SESSION_FILE, `${next.map(event => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 });
  return { sessionId, events: next.filter(event => event.nativeSessionId === sessionId), revision: sourceRevision(next) };
}

function discoverSessions() {
  const events = sourceEvents();
  if (events.length === 0) return [];
  const ids = [...new Set(events.map(event => event.nativeSessionId))];
  return ids.map(nativeSessionId => ({
    engineId: ENGINE_ID,
    nativeSessionId,
    sourceLocator: { relativePath: path.basename(SESSION_FILE) },
    project: process.cwd(),
  }));
}

function selectedSession(request) {
  const id = request.session && request.session.nativeSessionId;
  const sessions = discoverSessions();
  return sessions.find(session => session.nativeSessionId === id) || null;
}

function handleInitialize(request) {
  if (ADAPTER_PROTOCOL_VERSION !== EXTERNAL_ADAPTER_PROTOCOL_VERSION) {
    // Deliberately bypass the fixture's encoder to exercise the client's
    // version-mismatch diagnosis; production adapters must use the schema.
    process.stdout.write(`${JSON.stringify({
      type: 'initialized',
      protocolVersion: ADAPTER_PROTOCOL_VERSION,
      engineId: ENGINE_ID,
      correlationId: request.correlationId,
      capabilities,
    })}\n`);
    return;
  }
  if (request.protocolVersion !== EXTERNAL_ADAPTER_PROTOCOL_VERSION) {
    sendError(request, 'PROTOCOL_VERSION_MISMATCH', `supported=${EXTERNAL_ADAPTER_PROTOCOL_VERSION}`);
    return;
  }
  if (request.engineId !== ENGINE_ID) {
    sendError(request, 'ENGINE_ID_MISMATCH', ENGINE_ID);
    return;
  }
  send({
    type: 'initialized',
    protocolVersion: EXTERNAL_ADAPTER_PROTOCOL_VERSION,
    engineId: ENGINE_ID,
    correlationId: request.correlationId,
    capabilities,
    adapterVersion: 'fixture-1',
  });
}

function emitRun(request, input, nativeSessionId, revision) {
  const runId = request.runId || request.correlationId;
  const base = { runId, engineId: ENGINE_ID, nativeSessionId };
  send({ type: 'event', operation: 'run', correlationId: request.correlationId, event: { ...base, type: 'run_started', sequence: 0 } });
  send({ type: 'event', operation: 'run', correlationId: request.correlationId, event: { ...base, type: 'session_observed', sequence: 1 } });
  send({ type: 'event', operation: 'run', correlationId: request.correlationId, event: { ...base, type: 'message_delta', sequence: 2, text: `fixture:${String(input).slice(0, 256)}` } });
  send({ type: 'event', operation: 'run', correlationId: request.correlationId, event: { ...base, type: 'run_completed', sequence: 3, result: `fixture:${String(input).slice(0, 256)}` } });
  sendResponse(request, { output: `fixture:${String(input).slice(0, 256)}`, sessionId: nativeSessionId, sourceRevision: revision });
}

function handleRun(request) {
  if (!capabilities.run) {
    sendError(request, 'CAPABILITY_UNSUPPORTED', 'run');
    return;
  }
  const input = request.input === undefined ? request.prompt : request.input;
  if (String(input).includes('fixture-crash')) {
    process.stderr.write('fixture diagnostic secret=fixture-secret\n');
    process.exitCode = 17;
    process.exit(17);
  }
  if (String(input).includes('fixture-malformed')) {
    process.stdout.write('{malformed fixture record}\n');
    return;
  }
  runCount += 1;
  const run = appendSession(input, request);
  const delay = String(input).includes('fixture-sleep') ? 30000 : 0;
  if (delay > 0) {
    activeRun = { request, timer: setTimeout(() => {
      activeRun = null;
      emitRun(request, input, run.sessionId, run.revision);
    }, delay) };
    return;
  }
  emitRun(request, input, run.sessionId, run.revision);
}

function handleCancel(request) {
  if (!capabilities.cancel) {
    sendError(request, 'CAPABILITY_UNSUPPORTED', 'cancel');
    return;
  }
  if (activeRun) {
    clearTimeout(activeRun.timer);
    activeRun = null;
  }
  sendResponse(request, { cancelled: true, targetCorrelationId: request.targetCorrelationId || null, runId: request.runId || null });
}

function handleSessionDiscover(request) {
  if (!capabilities['session.discover']) return sendError(request, 'CAPABILITY_UNSUPPORTED', request.type);
  sendResponse(request, { sessions: discoverSessions(), cursor: null });
}

function handleSessionInspect(request) {
  if (!capabilities['session.inspect']) return sendError(request, 'CAPABILITY_UNSUPPORTED', request.type);
  const session = selectedSession(request);
  if (!session) return sendError(request, 'SESSION_SOURCE_MISSING', 'session not found');
  const allEvents = sourceEvents();
  const events = allEvents.filter(event => event.nativeSessionId === session.nativeSessionId);
  sendResponse(request, {
    revision: {
      ...session,
      sourceHash: sourceRevision(allEvents),
      sourceRevision: sourceRevision(allEvents),
      sourceSize: Buffer.byteLength(JSON.stringify(allEvents), 'utf8'),
      messageCount: events.filter(event => event.kind === 'message').length,
      cursor: { sequence: events.length },
    },
  });
}

function handleSessionRead(request) {
  if (!capabilities['session.read']) return sendError(request, 'CAPABILITY_UNSUPPORTED', request.type);
  const session = selectedSession(request);
  if (!session) return sendError(request, 'SESSION_SOURCE_MISSING', 'session not found');
  const events = sourceEvents().filter(event => event.nativeSessionId === session.nativeSessionId);
  sendResponse(request, { events, cursor: { sequence: events.length } });
}

function handleRequest(request) {
  if (request.type === 'initialize') return handleInitialize(request);
  if (request.type !== 'shutdown' && !capabilities[request.type]) {
    sendError(request, 'CAPABILITY_UNSUPPORTED', request.type);
    return;
  }
  if (request.type === 'probe') return sendResponse(request, { state: 'verified', available: true, reachable: true, verified: true });
  if (request.type === 'run') return handleRun(request);
  if (request.type === 'cancel') return handleCancel(request);
  if (request.type === 'session.discover') return handleSessionDiscover(request);
  if (request.type === 'session.inspect') return handleSessionInspect(request);
  if (request.type === 'session.read') return handleSessionRead(request);
  if (request.type === 'shutdown') {
    sendResponse(request, { shuttingDown: true });
    closing = true;
    setTimeout(() => process.exit(0), 0).unref();
  }
}

process.stdin.on('data', chunk => {
  try {
    for (const record of framer.feed(chunk)) handleRequest(record);
  } catch (error) {
    process.stderr.write(`fixture protocol error: ${String(error && error.code || 'invalid')}\n`);
    process.exitCode = 2;
    process.exit(2);
  }
});
process.stdin.on('end', () => {
  try { framer.end(); } catch { process.exitCode = 2; }
});

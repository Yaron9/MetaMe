'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultEngineRegistry } = require('./engine-registry');
const { runSessionSourceConformance } = require('./session-source-adapter');
const {
  createPiSessionSourceAdapter,
  _internal,
} = require('./pi-session-source-adapter');
const { getEngineDescriptor } = require('../core/engine-descriptors');

const FIXTURE = path.join(__dirname, 'pi-fixtures', 'pi-native-session.jsonl');

function makeHome(prefix = 'metame-pi-source-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFixture(dir, name = 'session.jsonl') {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.copyFileSync(FIXTURE, target);
  return target;
}

async function discoverAll(source, request = {}) {
  const refs = [];
  for await (const ref of source.discover(request)) refs.push(ref);
  return refs;
}

test('Pi source projects only the official active branch and compaction-aware context', async () => {
  const home = makeHome();
  const sessionDir = path.join(home, 'configured-sessions');
  copyFixture(sessionDir);
  const source = createPiSessionSourceAdapter({ home, sessionDir });
  const refs = await discoverAll(source);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].engineId, 'pi');
  assert.equal(refs[0].nativeSessionId, 'pi-fixture-session');
  assert.deepEqual(refs[0].sourceLocator, { root: 'configured', relativePath: 'session.jsonl' });
  assert.equal(JSON.stringify(refs[0].sourceLocator).includes(home), false);

  const revision = await source.inspect(refs[0]);
  assert.equal(revision.unknownRecordCount, 1);
  assert.equal(revision.partialFinalLine, false);
  assert.equal(revision.eventLimitExceeded, false);
  const events = [];
  for await (const event of source.read(refs[0], { sourceRevision: revision.sourceRevision })) events.push(event);
  assert.deepEqual(events.map(event => `${event.actor}:${event.kind}`), [
    'system:checkpoint', 'user:message', 'assistant:message', 'tool:tool_call', 'tool:tool_result',
    'user:message', 'user:message', 'assistant:message', 'system:checkpoint', 'user:message', 'assistant:message',
  ]);
  assert.equal(events.some(event => event.text.includes('Abandoned branch')), false);
  assert.equal(events.some(event => event.text.includes('private reasoning')), false);
  assert.equal(events.find(event => event.kind === 'tool_call').tool, 'read');
  assert.equal(events.find(event => event.kind === 'tool_result').outcome.error, false);
  assert.ok(events.every(event => event.engineId === 'pi'));
  assert.ok(events.every(event => event.sourceRevision === revision.sourceRevision));
  assert.equal(runSessionSourceConformance(source).ok, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi discovery is bounded newest-first and resumes a stable snapshot cursor', async () => {
  const home = makeHome();
  const sessionDir = path.join(home, 'sessions');
  const oldPath = copyFixture(sessionDir, 'old.jsonl');
  const newPath = copyFixture(sessionDir, 'new.jsonl');
  const oldText = fs.readFileSync(oldPath, 'utf8').replace('pi-fixture-session', 'pi-old');
  const newText = fs.readFileSync(newPath, 'utf8').replace('pi-fixture-session', 'pi-new');
  fs.writeFileSync(oldPath, oldText);
  fs.writeFileSync(newPath, newText);
  const oldDate = new Date('2026-08-01T00:00:00Z');
  const newDate = new Date('2026-08-02T00:00:00Z');
  fs.utimesSync(oldPath, oldDate, oldDate);
  fs.utimesSync(newPath, newDate, newDate);
  const source = createPiSessionSourceAdapter({ home, sessionDir });
  const first = await discoverAll(source, { limit: 1 });
  assert.equal(first[0].nativeSessionId, 'pi-new');
  assert.ok(first[0].discoveryCursor);
  fs.utimesSync(oldPath, new Date('2026-08-03T00:00:00Z'), new Date('2026-08-03T00:00:00Z'));
  const second = await discoverAll(source, { limit: 1, cursor: first[0].discoveryCursor });
  assert.deepEqual(second.map(ref => ref.nativeSessionId), ['pi-old']);
  await assert.rejects(
    async () => { for await (const _ref of source.discover({ project: 'different', cursor: first[0].discoveryCursor })) { /* consume */ } },
    /session_source_.*cursor_invalid/,
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi discovery reads only a bounded header prefix from large sessions', async () => {
  const home = makeHome();
  const sessionDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const largePath = path.join(sessionDir, 'large.jsonl');
  const header = {
    type: 'session', version: 3, id: 'pi-large', timestamp: '2026-08-01T00:00:00.000Z', cwd: home,
  };
  const largeBody = JSON.stringify({
    type: 'custom', id: 'large-body', parentId: null, payload: 'x'.repeat(_internal.MAX_HEADER_BYTES + 4096),
  });
  fs.writeFileSync(largePath, `${JSON.stringify(header)}\n${largeBody}\n`, 'utf8');
  assert.ok(fs.statSync(largePath).size > _internal.MAX_HEADER_BYTES);

  const readSizes = [];
  const observedFs = {
    ...fs,
    readSync(fd, buffer, offset, length, position) {
      const count = fs.readSync(fd, buffer, offset, length, position);
      readSizes.push(count);
      return count;
    },
  };
  const source = createPiSessionSourceAdapter({ home, sessionDir, fs: observedFs });
  const refs = await discoverAll(source);
  assert.deepEqual(refs.map(ref => ref.nativeSessionId), ['pi-large']);
  assert.ok(readSizes.length > 0);
  assert.ok(readSizes.every(size => size <= _internal.MAX_HEADER_BYTES));
  assert.ok(readSizes.reduce((total, size) => total + size, 0) <= _internal.MAX_HEADER_BYTES);

  // A header crossing the read chunk boundary and using CRLF remains valid.
  const crossReadPath = path.join(sessionDir, 'cross-read.jsonl');
  const crossReadHeader = {
    type: 'session', version: 3, id: 'pi-cross-read', cwd: home, padding: 'x'.repeat(70 * 1024),
  };
  fs.writeFileSync(crossReadPath, `${JSON.stringify(crossReadHeader)}\r\n`, 'utf8');
  assert.equal(_internal.readHeaderBounded(crossReadPath, fs, path, sessionDir).id, 'pi-cross-read');

  // A first line with no LF inside the prefix is explicitly skipped; a later
  // valid-looking record must not be mistaken for the session header.
  const oversizedHeaderPath = path.join(sessionDir, 'oversized-header.jsonl');
  const oversizedHeader = {
    type: 'session', version: 3, id: 'pi-oversized-header', cwd: home,
    padding: 'x'.repeat(_internal.MAX_HEADER_BYTES + 64),
  };
  fs.writeFileSync(oversizedHeaderPath, `${JSON.stringify(oversizedHeader)}\n${JSON.stringify(header)}\n`, 'utf8');
  assert.equal(_internal.readHeaderBounded(oversizedHeaderPath, fs, path, sessionDir), null);
  const oversizedSource = createPiSessionSourceAdapter({ home, sessionDir });
  const oversizedRefs = await discoverAll(oversizedSource);
  assert.equal(oversizedRefs.some(ref => ref.nativeSessionId === 'pi-oversized-header'), false);

  // Short reads still progress, and read failures close the descriptor opened
  // for the bounded prefix.
  const shortReadFs = {
    ...fs,
    readSync(fd, buffer, offset, length, position) {
      return fs.readSync(fd, buffer, offset, Math.min(length, 7), position);
    },
  };
  assert.equal(_internal.readHeaderBounded(crossReadPath, shortReadFs, path, sessionDir).id, 'pi-cross-read');
  let closeCalls = 0;
  const failingReadFs = {
    ...fs,
    readSync() { throw new Error('read failed'); },
    closeSync(fd) { closeCalls += 1; return fs.closeSync(fd); },
  };
  assert.equal(_internal.readHeaderBounded(largePath, failingReadFs, path, sessionDir), null);
  assert.equal(closeCalls, 1);

  const leadingDir = path.join(home, 'leading');
  fs.mkdirSync(leadingDir, { recursive: true });
  const leadingPath = path.join(leadingDir, 'leading.jsonl');
  const leadingHeader = {
    type: 'session', version: 3, id: 'pi-leading', timestamp: '2026-08-01T00:00:00.000Z', cwd: home,
  };
  fs.writeFileSync(leadingPath, `\uFEFF\n  \t\r\n${JSON.stringify(leadingHeader)}\r\n`, 'utf8');
  const leadingSource = createPiSessionSourceAdapter({ home, sessionDir: leadingDir });
  const leadingRefs = await discoverAll(leadingSource);
  assert.equal(leadingRefs.length, 1);
  const leadingRevision = await leadingSource.inspect(leadingRefs[0]);
  assert.equal(leadingRevision.nativeSessionId, 'pi-leading');
  assert.equal(leadingRefs[0].nativeSessionId, leadingRevision.nativeSessionId);

  const finalLinePath = path.join(leadingDir, 'final-line.jsonl');
  const finalLineHeader = {
    type: 'session', version: 3, id: 'pi-final-line', timestamp: '2026-08-01T00:00:00.000Z', cwd: home,
  };
  fs.writeFileSync(finalLinePath, JSON.stringify(finalLineHeader), 'utf8');
  const finalLineSource = createPiSessionSourceAdapter({ home, sessionDir: leadingDir });
  const finalLineRefs = await discoverAll(finalLineSource);
  const finalLineRef = finalLineRefs.find(ref => ref.nativeSessionId === 'pi-final-line');
  assert.ok(finalLineRef, 'a complete JSON final line without LF remains discoverable');
  assert.equal((await finalLineSource.inspect(finalLineRef)).nativeSessionId, 'pi-final-line');

  const utf8Path = path.join(leadingDir, 'utf8-header.jsonl');
  const utf8Header = {
    type: 'session', version: 3, id: 'pi-utf8-header', timestamp: '2026-08-01T00:00:00.000Z', cwd: home,
    note: '你好世界'.repeat(20000),
  };
  fs.writeFileSync(utf8Path, `${JSON.stringify(utf8Header)}\n`, 'utf8');
  const utf8Source = createPiSessionSourceAdapter({ home, sessionDir: leadingDir });
  const utf8Refs = await discoverAll(utf8Source);
  const utf8Ref = utf8Refs.find(ref => ref.nativeSessionId === 'pi-utf8-header');
  assert.ok(utf8Ref, 'UTF-8 header crossing read chunks must be discoverable');
  assert.equal((await utf8Source.inspect(utf8Ref)).nativeSessionId, 'pi-utf8-header');

  const whitespacePath = path.join(leadingDir, 'whitespace.jsonl');
  fs.writeFileSync(whitespacePath, ' \t\r\n'.repeat(Math.ceil(_internal.MAX_HEADER_BYTES / 4) + 1), 'utf8');
  const whitespaceSource = createPiSessionSourceAdapter({ home, sessionDir: leadingDir });
  const whitespaceRefs = await discoverAll(whitespaceSource);
  assert.equal(whitespaceRefs.some(ref => ref.sourceLocator.relativePath === 'whitespace.jsonl'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi revisions expose append cursor and hold an incomplete final line', async () => {
  const home = makeHome();
  const sessionDir = path.join(home, 'sessions');
  const filePath = copyFixture(sessionDir, 'partial.jsonl');
  fs.appendFileSync(filePath, JSON.stringify({
    type: 'message', id: 'partial', parentId: 'a-after', timestamp: '2026-08-01T10:04:00.000Z',
    message: { role: 'user', content: 'torn tail' },
  }).slice(0, 30));
  const source = createPiSessionSourceAdapter({ home, sessionDir });
  const ref = (await discoverAll(source))[0];
  const partial = await source.inspect(ref);
  assert.equal(partial.partialFinalLine, true);
  assert.equal(partial.cursor.sequence, 16);
  const completeLine = JSON.stringify({
    type: 'message', id: 'partial', parentId: 'a-after', timestamp: '2026-08-01T10:04:00.000Z',
    message: { role: 'user', content: 'complete tail' },
  });
  fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace(/[^\n]*$/, completeLine));
  const grown = await source.inspect(ref);
  assert.notEqual(grown.sourceRevision, partial.sourceRevision);
  const resumed = [];
  for await (const event of source.read(ref, { sourceRevision: grown.sourceRevision, cursor: partial.cursor })) resumed.push(event);
  assert.deepEqual(resumed.map(event => event.text), ['complete tail']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi source reports malformed, path, symlink, oversize and event-cap failures', async () => {
  const home = makeHome();
  const sessionDir = path.join(home, 'sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'malformed.jsonl'), '{not-json}\n');
  const source = createPiSessionSourceAdapter({ home, sessionDir });
  assert.deepEqual(await discoverAll(source), []);
  const malformed = { engineId: 'pi', nativeSessionId: 'malformed', sourceLocator: { root: 'configured', relativePath: 'malformed.jsonl' } };
  assert.equal((await source.validate(malformed)).valid, false);
  await assert.rejects(() => source.inspect({ ...malformed, sourceLocator: { root: 'configured', relativePath: '../escape.jsonl' } }), /session_source_.*locator_invalid/);

  const oversizedPath = copyFixture(sessionDir, 'oversized.jsonl');
  const limited = createPiSessionSourceAdapter({ home, sessionDir, maxFileSize: 20 });
  const oversizedRef = { engineId: 'pi', nativeSessionId: 'pi-fixture-session', sourceLocator: { root: 'configured', relativePath: 'oversized.jsonl' } };
  assert.match((await limited.validate(oversizedRef)).errorCode, /too_large/);
  const capped = createPiSessionSourceAdapter({ home, sessionDir, maxEvents: 1 });
  const capRef = (await discoverAll(capped)).find(ref => ref.nativeSessionId === 'pi-fixture-session');
  assert.equal((await capped.validate(capRef)).errorCode, 'PI_EVENT_LIMIT');

  const symlinkPath = path.join(sessionDir, 'symlink.jsonl');
  try { fs.symlinkSync(oversizedPath, symlinkPath); } catch { /* platform may disallow symlinks */ }
  if (fs.existsSync(symlinkPath) && fs.lstatSync(symlinkPath).isSymbolicLink()) {
    const symlinkRef = { engineId: 'pi', nativeSessionId: 'pi-fixture-session', sourceLocator: { root: 'configured', relativePath: 'symlink.jsonl' } };
    assert.match((await source.validate(symlinkRef)).errorCode, /invalid|missing/);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('base Pi descriptor remains runtime-only while built-in registry verifies source override', () => {
  assert.equal(getEngineDescriptor('pi').capabilities.sessionSource.state, 'unsupported');
  const home = makeHome();
  const registry = createDefaultEngineRegistry({
    pi: { home, binary: '/opt/test/pi', sessionDir: path.join(home, 'sessions') },
  });
  const plugin = registry.lookup('pi');
  assert.equal(plugin.descriptor.capabilities.sessionSource.state, 'verified');
  assert.equal(typeof plugin.sessionSource.discover, 'function');
  assert.equal(runSessionSourceConformance(plugin.sessionSource).ok, true);
  assert.equal(registry.disable('pi'), true);
  assert.equal(registry.lookup('pi'), plugin);
  assert.equal(registry.resolve('pi').reason, 'engine_disabled');
  assert.equal(registry.lookup('pi', { includeDisabled: false }), null);
  assert.equal(registry.remove('pi'), true);
  assert.equal(registry.lookup('pi'), null);
  assert.deepEqual(registry.retiredIds(), ['pi']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Pi branch helper follows parentId to the active leaf and ignores plain custom entries', () => {
  const entries = [
    { record: { type: 'message', id: 'root', parentId: null }, nativeSequence: 1 },
    { record: { type: 'custom', id: 'custom', parentId: 'root' }, nativeSequence: 2 },
    { record: { type: 'message', id: 'branch', parentId: 'root' }, nativeSequence: 3 },
  ];
  assert.deepEqual(_internal.activePath(entries).map(item => item.record.id), ['root', 'branch']);
  assert.deepEqual(_internal.buildContextEntries(entries).map(item => item.record.id), ['root', 'branch']);
});

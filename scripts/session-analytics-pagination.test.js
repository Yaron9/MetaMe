'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function runChild(home, source) {
  return execFileSync(process.execPath, ['-e', source], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function makeHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, '.metame'), { recursive: true });
  return home;
}

test('session analytics read checks do not create or rewrite source metadata', () => {
  const home = makeHome('metame-analytics-read-');
  runChild(home, `
    const assert = require('node:assert/strict');
    const { DatabaseSync } = require('node:sqlite');
    const { upsertSessionSource } = require('./scripts/core/session-source-db');
    const analytics = require('./scripts/session-analytics');
    const sources = analytics._internal.getSessionSources();
    sources.set('claude', {
      discover: function* discover() {
        yield { engineId: 'claude', nativeSessionId: 'read-only-session', sourceRevision: 'read-only-revision', sourceLocator: { relativePath: 'read-only.jsonl' } };
      },
      resolveSessionRefPath: ref => '/tmp/' + ref.nativeSessionId + '.jsonl',
      inspectPath: (_filePath, ref) => ({
        nativeSessionId: ref.nativeSessionId,
        sourceRevision: ref.sourceRevision,
        sourceLocator: ref.sourceLocator,
        sourceSize: 42,
        project: 'discovered-project',
        cwd: '/discovered',
        lastModified: '2026-08-01T00:00:00.000Z',
      }),
    });
    const dbPath = require('node:path').join(process.env.HOME, '.metame', 'memory.db');
    const db = new DatabaseSync(dbPath);
    upsertSessionSource(db, {
      engineId: 'claude',
      nativeSessionId: 'read-only-session',
      sourceHash: 'read-only-revision',
      project: 'preserved-project',
      scope: 'preserved-scope',
      cwd: '/preserved',
      sourceLocator: { original: 'preserved-locator' },
      sourceSize: 999,
      sourceState: 'missing',
      status: 'error',
      errorCode: 'KEEP_ME',
      errorMessage: 'preserve this row',
    });
    const select = () => db.prepare(
      'SELECT project, scope, cwd, source_locator, source_size, source_state, status, error_code, error_message, updated_at FROM session_sources WHERE engine_id=? AND native_session_id=? AND source_hash=?',
    ).get('claude', 'read-only-session', 'read-only-revision');
    const before = select();
    assert.equal(analytics._internal.isProcessed('analyzed', 'missing-session', 'missing-revision', 'canonical', 'claude'), false);
    assert.equal(analytics._internal.isProcessed('analyzed', 'read-only-session', 'read-only-revision', 'canonical', 'claude'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_sources').get().count, 1);
    const listed = (async () => analytics.findAllUnanalyzedSessions(1, { discoveryPageSize: 1 }))();
    listed.then(rows => {
      assert.equal(rows.length, 1);
      assert.equal(rows[0].session_id, 'read-only-session');
      const after = select();
      assert.deepEqual(after, before);
      db.close();
    }).catch(error => {
      try { db.close(); } catch {}
      console.error(error);
      process.exitCode = 1;
    });
  `);
});

test('session analytics paginates past processed newer sessions and honors cursor safety bounds', () => {
  const home = makeHome('metame-analytics-pages-');
  runChild(home, `
    const assert = require('node:assert/strict');
    const analytics = require('./scripts/session-analytics');
    const sources = analytics._internal.getSessionSources();
    const refs = Array.from({ length: 24 }, (_, index) => ({
      engineId: 'claude',
      nativeSessionId: 'page-session-' + index,
      sourceRevision: 'page-revision-' + index,
      sourceLocator: { relativePath: 'page-' + index + '.jsonl' },
    }));
    let calls = 0;
    const source = {
      discover(request = {}) {
        calls += 1;
        const offset = Number(request.cursor || 0);
        const limit = Number(request.limit || 1);
        const page = refs.slice(offset, offset + limit).map(ref => ({ ...ref }));
        if (page.length && offset + page.length < refs.length) page.at(-1).discoveryCursor = offset + page.length;
        return page;
      },
      listSessionRefs() { throw new Error('legacy listSessionRefs must not be selected'); },
      resolveSessionRefPath: ref => '/tmp/' + ref.nativeSessionId + '.jsonl',
      inspectPath: (_filePath, ref) => ({
        nativeSessionId: ref.nativeSessionId,
        sourceRevision: ref.sourceRevision,
        sourceLocator: ref.sourceLocator,
        sourceSize: 1,
        project: 'page-project',
        cwd: '/page-project',
        lastModified: new Date(Date.UTC(2026, 7, 1, 0, 0, 24 - Number(ref.nativeSessionId.split('-').at(-1)))).toISOString(),
      }),
    };
    sources.set('claude', source);
    for (const ref of refs.slice(0, 20)) {
      analytics._internal.markProcessed('analyzed', ref.nativeSessionId, ref.sourceRevision, 'canonical', 'claude', {
        project: 'page-project', sourceLocator: ref.sourceLocator, sourceSize: 1, cwd: '/page-project',
      });
    }
    (async () => {
      const rows = await analytics.findAllUnanalyzedSessions(1, { discoveryPageSize: 1, discoveryScanBudget: 40 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].session_id, 'page-session-20');
      assert.ok(calls > 3, 'the scan must continue beyond the old max*3 cap');

      let loopCalls = 0;
      sources.set('claude', {
        discover() {
          loopCalls += 1;
          return [{ engineId: 'claude', nativeSessionId: 'loop-session', sourceRevision: 'loop-revision', sourceLocator: { relativePath: 'loop.jsonl' }, discoveryCursor: { same: true } }];
        },
        resolveSessionRefPath: ref => '/tmp/' + ref.nativeSessionId + '.jsonl',
        inspectPath: (_filePath, ref) => ({ nativeSessionId: ref.nativeSessionId, sourceRevision: ref.sourceRevision, sourceLocator: ref.sourceLocator, sourceSize: 1, project: 'loop', lastModified: '2026-08-01T00:00:00.000Z' }),
      });
      await analytics.findAllUnanalyzedSessions(10, { discoveryPageSize: 1, discoveryScanBudget: 100 });
      assert.ok(loopCalls <= 2, 'a repeated cursor must terminate pagination');

      let boundedCalls = 0;
      sources.set('claude', {
        discover(request = {}) {
          boundedCalls += 1;
          const offset = Number(request.cursor || 0);
          return [{ engineId: 'claude', nativeSessionId: 'bounded-' + offset, sourceRevision: 'bounded-revision-' + offset, sourceLocator: { relativePath: 'bounded-' + offset + '.jsonl' }, discoveryCursor: offset + 1 }];
        },
        resolveSessionRefPath: ref => '/tmp/' + ref.nativeSessionId + '.jsonl',
        inspectPath: (_filePath, ref) => ({ nativeSessionId: ref.nativeSessionId, sourceRevision: ref.sourceRevision, sourceLocator: ref.sourceLocator, sourceSize: 1, project: 'bounded', lastModified: '2026-08-01T00:00:00.000Z' }),
      });
      await analytics.findAllUnanalyzedSessions(100, { discoveryPageSize: 1, discoveryScanBudget: 7 });
      assert.equal(boundedCalls, 7);
    })().then(() => process.exit(0)).catch(error => {
      console.error(error);
      process.exit(1);
    });
  `);
});

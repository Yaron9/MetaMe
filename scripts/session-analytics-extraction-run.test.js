'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

test('session analytics processing uses the shared extraction-run table', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-analytics-run-'));
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const analytics = require('./scripts/session-analytics');
    const { upsertSessionSource } = require('./scripts/core/session-source-db');
    const dbPath = path.join(process.env.HOME, '.metame', 'memory.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const seedDb = new DatabaseSync(dbPath);
    upsertSessionSource(seedDb, {
      engineId: 'fixture',
      nativeSessionId: 'session-1',
      sourceHash: 'revision-1',
      project: 'fixture-project',
      cwd: '/tmp/fixture',
      sourceLocator: { relativePath: 'session-1.jsonl' },
      sourceSize: 12,
    });
    seedDb.close();
    analytics._internal.markProcessed('analyzed', 'session-1', 'revision-1', 'ignored-by-canonical-path', 'fixture', {
      project: 'fixture-project',
      cwd: '/tmp/fixture',
      sourceLocator: { relativePath: 'session-1.jsonl' },
      sourceSize: 12,
    });
    assert(analytics._internal.isProcessed('analyzed', 'session-1', 'revision-1', 'ignored-by-canonical-path', 'fixture'));
    const db = new DatabaseSync(require('node:path').join(process.env.HOME, '.metame', 'memory.db'));
    const row = db.prepare('SELECT status, pipeline_version FROM extraction_runs').get();
    if (!row || row.status !== 'completed' || !row.pipeline_version.includes(':analytics')) process.exit(2);
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'processed_%'").get()) process.exit(3);
    db.close();
  `;
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: 'pipe',
  });
});

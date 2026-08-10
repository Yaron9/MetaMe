'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function withFreshMemoryHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-claim-contract-'));
  const previousHome = process.env.HOME;
  process.env.HOME = tmpDir;
  delete require.cache[require.resolve('./memory')];
  delete require.cache[require.resolve('./memory-wiki-schema')];
  const memory = require('./memory');
  try {
    fn(memory);
  } finally {
    try { memory.forceClose(); } catch { /* best effort */ }
    process.env.HOME = previousHome;
    delete require.cache[require.resolve('./memory')];
    delete require.cache[require.resolve('./memory-wiki-schema')];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function fact(overrides = {}) {
  return {
    entity: 'metame.claim.contract',
    relation: 'arch_convention',
    value: 'Claim admission keeps uncertain lifecycle material task-local until explicitly classified.',
    confidence: 'high',
    ...overrides,
  };
}

test('saveFacts omission fails closed to an active task Episode', () => {
  withFreshMemoryHome(memory => {
    const result = memory.saveFacts('session-unknown', 'metame', [fact()]);
    assert.equal(result.saved, 1);
    const db = new DatabaseSync(memory.DB_PATH, { readOnly: true });
    try {
      const row = db.prepare(`
        SELECT kind,state,canonical_key,task_key,project
          FROM memory_items
         WHERE id=?
      `).get(result.savedFacts[0].id);
      assert.deepEqual({ ...row }, {
        kind: 'episode',
        state: 'active',
        canonical_key: null,
        task_key: 'session-unknown',
        project: 'metame',
      });
    } finally {
      db.close();
    }
  });
});

test('saveFacts requires explicit lifecycle for a durable candidate', () => {
  withFreshMemoryHome(memory => {
    const result = memory.saveFacts('session-project', 'metame', [fact({
      lifecycle: 'project',
      canonical_key: 'metame.claim.contract',
    })], { scope: 'core' });
    assert.equal(result.saved, 1);
    const db = new DatabaseSync(memory.DB_PATH, { readOnly: true });
    try {
      const row = db.prepare(`
        SELECT kind,state,canonical_key,task_key,project,scope
          FROM memory_items
         WHERE id=?
      `).get(result.savedFacts[0].id);
      assert.deepEqual({ ...row }, {
        kind: 'convention',
        state: 'candidate',
        canonical_key: 'metame.claim.contract',
        task_key: null,
        project: 'metame',
        scope: 'core',
      });
    } finally {
      db.close();
    }
  });
});

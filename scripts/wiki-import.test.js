'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { scanFiles, generateUniqueSlug } = require('./wiki-import');

function openTestDb() {
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  return db;
}

describe('scanFiles', () => {
  it('returns realpath-normalized file list for a directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));
    fs.writeFileSync(path.join(tmpDir, 'a.md'), '# A');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'B');
    fs.writeFileSync(path.join(tmpDir, 'c.pdf'), '%PDF');
    fs.writeFileSync(path.join(tmpDir, 'skip.js'), 'skip'); // not imported

    const files = scanFiles(tmpDir);
    const names = files.map(f => path.basename(f));
    assert.ok(names.includes('a.md'));
    assert.ok(names.includes('b.txt'));
    assert.ok(names.includes('c.pdf'));
    assert.ok(!names.includes('skip.js'));
    // All paths should be realpath
    assert.ok(files.every(f => path.isAbsolute(f)));
  });

  it('returns array with single file path when given a file', () => {
    const tmpFile = path.join(os.tmpdir(), 'single.md');
    fs.writeFileSync(tmpFile, '# Single');
    const files = scanFiles(tmpFile);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('single.md'));
  });
});

describe('generateUniqueSlug', () => {
  it('returns slug when no conflict', () => {
    const db = openTestDb();
    const slug = generateUniqueSlug(db, 'my-document');
    assert.equal(slug, 'my-document');
  });

  it('appends -2 on conflict', () => {
    const db = openTestDb();
    const { upsertWikiPage } = require('./core/wiki-db');
    upsertWikiPage(db, { slug: 'my-doc', title: 'X', primary_topic: 'x', content: 'c' });
    const slug = generateUniqueSlug(db, 'my-doc');
    assert.equal(slug, 'my-doc-2');
  });
});

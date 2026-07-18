'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectCandidates, groupBySize, buildDuplicateGroups, parseFclonesJson } = require('./file-map-dupes');

const hashers = {
  hashHead: async (p, n) => fs.readFileSync(p).subarray(0, n).toString('hex'),
  hashFull: async (p) => fs.readFileSync(p).toString('hex'),
};

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-dup-'));
  const w = (rel, content) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };
  // identical pair
  w('a/copy1.bin', 'SAME-CONTENT-1234567890');
  w('b/copy2.bin', 'SAME-CONTENT-1234567890');
  // same size, different from byte 0
  w('a/diff1.bin', 'XXXX-CONTENT-1234567890');
  // same head (first 4 bytes), different tail, distinct length so they get
  // their own size bucket — needs tiny headBytes to exercise stage 3
  w('a/head1.bin', 'SAMEhead-original-tail!!');
  w('b/head2.bin', 'SAMEhead-differed-tail!!');
  // excluded + hidden + tiny
  w('node_modules/copy3.bin', 'SAME-CONTENT-1234567890');
  w('.hidden/copy4.bin', 'SAME-CONTENT-1234567890');
  w('a/tiny.txt', 'x');
  return root;
}

describe('file-map-dupes collect', () => {
  it('respects minSize, excludes, hidden dirs and maxFiles truncation', () => {
    const root = makeTree();
    const out = collectCandidates({ fsx: fs }, { root, minSizeBytes: 10, excludePatterns: ['**/node_modules/**'] });
    const names = out.files.map(f => path.basename(f.path)).sort();
    assert.deepEqual(names, ['copy1.bin', 'copy2.bin', 'diff1.bin', 'head1.bin', 'head2.bin']);
    assert.equal(out.truncated, false);

    const capped = collectCandidates({ fsx: fs }, { root, minSizeBytes: 1, excludePatterns: [], maxFiles: 2 });
    assert.equal(capped.truncated, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('file-map-dupes grouping', () => {
  it('three-stage funnel: size → head → full separates true duplicates', async () => {
    const root = makeTree();
    const { files } = collectCandidates({ fsx: fs }, { root, minSizeBytes: 10, excludePatterns: ['**/node_modules/**'] });
    const groups = await buildDuplicateGroups(groupBySize(files), hashers, { headBytes: 4 });
    assert.equal(groups.length, 1, 'only the identical pair survives full hashing');
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].confidence, 'confirmed');
    assert.equal(groups[0].wasted_bytes, groups[0].size);
    assert.deepEqual(groups[0].files.map(f => path.basename(f)).sort(), ['copy1.bin', 'copy2.bin']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('oversized files skip full hashing and downgrade to probable', async () => {
    const root = makeTree();
    const { files } = collectCandidates({ fsx: fs }, { root, minSizeBytes: 10, excludePatterns: ['**/node_modules/**'] });
    const groups = await buildDuplicateGroups(groupBySize(files), hashers, { headBytes: 4, fullHashMaxBytes: 5 });
    assert.ok(groups.every(g => g.confidence === 'probable'), 'no group can be confirmed without full hashing');
    assert.ok(groups.some(g => g.files.some(f => f.endsWith('head1.bin'))), 'head-same/tail-diff pair reported as probable (the price of skipping stage 3)');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hash failures drop the file, not the run', async () => {
    const failing = {
      hashHead: async (p) => { if (p.includes('copy1')) throw new Error('io'); return 'H'; },
      hashFull: async () => 'F',
    };
    const groups = await buildDuplicateGroups(new Map([[20, ['/x/copy1', '/x/copy2', '/x/copy3']]]), failing, {});
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].files, ['/x/copy2', '/x/copy3']);
  });
});

describe('file-map-dupes fclones adapter', () => {
  it('parses object and array shapes, filters singletons, sorts by waste', () => {
    const payload = {
      groups: [
        { file_len: 10, files: ['/a/1', '/a/2'] },
        { file_len: 999, files: [{ path: '/b/1' }, { path: '/b/2' }, { path: '/b/3' }] },
        { file_len: 5, files: ['/only-one'] },
      ],
    };
    const groups = parseFclonesJson(JSON.stringify(payload));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].size, 999, 'sorted by wasted bytes desc');
    assert.equal(groups[0].count, 3);
    assert.equal(groups[0].wasted_bytes, 1998);
    assert.equal(parseFclonesJson('not json'), null);
    assert.equal(parseFclonesJson('{"unexpected":true}'), null);
  });
});

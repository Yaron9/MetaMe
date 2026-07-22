'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAnalyzeJson, parseCleanList, isPreviewFresh } = require('./file-map-mole');

describe('file-map Mole adapter', () => {
  it('normalizes and caps analyze JSON without trusting unknown fields', () => {
    const out = parseAnalyzeJson(JSON.stringify({
      path: '/home/u', overview: true, total_size: 30, total_files: 2,
      entries: [
        { name: 'A', path: '/home/u/A', size: 20, is_dir: true, insight: true, ignored: 'x' },
        { path: '/home/u/b', size: '10' },
      ],
      large_files: [{ path: '/home/u/b', size: 10 }],
    }), { limit: 1 });
    assert.equal(out.ok, true);
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].insight, true);
    assert.equal(out.large_files.length, 1);
    assert.equal(out.truncated, true);
  });

  it('fails in-band for malformed or unsupported analyze output', () => {
    assert.equal(parseAnalyzeJson('{').ok, false);
    assert.equal(parseAnalyzeJson('{}').ok, false);
  });

  it('parses an absolute-path clean list and removes exact duplicates', () => {
    assert.deepEqual(parseCleanList('/a\nrelative\n/a\n/b\n\n'), ['/a', '/b']);
    assert.deepEqual(parseCleanList('/a\n/b\n/c\n', { limit: 2 }), ['/a', '/b']);
  });

  it('enforces preview TTL without accepting future timestamps', () => {
    assert.equal(isPreviewFresh(1000, 1500, 1000), true);
    assert.equal(isPreviewFresh(1000, 2501, 1000), false);
    assert.equal(isPreviewFresh(2000, 1000, 1000), false);
  });
});

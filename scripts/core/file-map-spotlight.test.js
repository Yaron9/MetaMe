'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildQueryExpression, buildSearchArgs, buildLargeQuery, buildStaleQuery,
  parsePathList, parseMdlsRaw, parseSpotlightDate, parseCount,
} = require('./file-map-spotlight');

describe('file-map-spotlight builders', () => {
  it('plain query searches display name + text content, case/diacritic insensitive', () => {
    const expr = buildQueryExpression({ query: 'drilling report' });
    assert.match(expr, /kMDItemDisplayName == "\*drilling report\*"cd/);
    assert.match(expr, /kMDItemTextContent == "drilling report"cd/);
  });

  it('raw kMDItem expressions pass through, quotes in plain values are stripped', () => {
    assert.equal(buildQueryExpression({ query: 'kMDItemFSSize > 100' }), '(kMDItemFSSize > 100)');
    assert.ok(!buildQueryExpression({ query: 'a"b\\c' }).includes('"b'), 'injection characters removed');
  });

  it('filters combine with &&', () => {
    const expr = buildQueryExpression({ query: 'x', kind: 'image', modifiedWithinDays: 7, minSizeMb: 2 });
    assert.match(expr, /public\.image/);
    assert.match(expr, /kMDItemFSContentChangeDate >= \$time\.today\(-7\)/);
    assert.match(expr, /kMDItemFSSize > 2097152/);
    assert.equal(expr.split(' && ').length, 4);
  });

  it('name-only uses -name fast path; name + filters folds into expression', () => {
    const fast = buildSearchArgs({ root: '/r', name: 'foo' });
    assert.deepEqual(fast, ['-onlyin', '/r', '-0', '-name', 'foo']);
    const mixed = buildSearchArgs({ root: '/r', name: 'foo', minSizeMb: 1 });
    assert.ok(mixed.some(a => a.includes('kMDItemFSName == "*foo*"cd')));
    const empty = buildSearchArgs({ root: '/r' });
    assert.equal(empty, null, 'nothing to search for');
  });

  it('count mode swaps -0 for -count', () => {
    const args = buildSearchArgs({ root: '/r', query: 'x', countOnly: true });
    assert.ok(args.includes('-count'));
    assert.ok(!args.includes('-0'));
  });

  it('stale query guards the null kMDItemLastUsedDate population', () => {
    const q = buildStaleQuery({ unusedDays: 180, minSizeMb: 10 });
    assert.match(q, /kMDItemFSSize > 10485760/);
    assert.match(q, /kMDItemLastUsedDate < \$time\.today\(-180\)/);
    assert.match(q, /kMDItemLastUsedDate != "\*"/, 'null-attribute files must be included');
    assert.match(buildLargeQuery({ minSizeMb: 100 }), /kMDItemFSSize > 104857600/);
  });
});

describe('file-map-spotlight parsers', () => {
  it('parsePathList handles NUL and newline modes', () => {
    assert.deepEqual(parsePathList('/a\0/b\0', { nul: true }), ['/a', '/b']);
    assert.deepEqual(parsePathList('/a\n/b\n\n', { nul: false }), ['/a', '/b']);
    assert.deepEqual(parsePathList('', { nul: true }), []);
  });

  it('parseMdlsRaw maps NUL-separated values per file with (null) → null', () => {
    const out = parseMdlsRaw('2026-07-17 00:58:18 +0000\0(null)\0', 3);
    assert.equal(out.length, 3);
    assert.match(out[0], /2026-07-17/);
    assert.equal(out[1], null);
    assert.equal(out[2], null, 'missing trailing values pad as null');
  });

  it('parseSpotlightDate converts to ISO, garbage → null', () => {
    assert.equal(parseSpotlightDate('2026-07-17 00:58:18 +0000'), '2026-07-17T00:58:18.000Z');
    assert.equal(parseSpotlightDate('(null)'), null);
    assert.equal(parseSpotlightDate(null), null);
  });

  it('parseCount parses mdfind -count output', () => {
    assert.equal(parseCount('78\n'), 78);
    assert.equal(parseCount('garbage'), null);
  });
});

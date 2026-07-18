'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  scanStructure, parseDuKb, mergeSizes, isCacheFresh, cacheMatchesScope, renderOverviewMarkdown,
} = require('./file-map-overview');
const { normalizeConfig } = require('./file-map-config');

const NOW = Date.parse('2026-07-18T00:00:00Z');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-ov-'));
  fs.mkdirSync(path.join(root, 'Documents', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Documents', 'a.pdf'), 'a');
  fs.writeFileSync(path.join(root, 'Documents', 'b.pdf'), 'b');
  fs.writeFileSync(path.join(root, 'Documents', 'c.txt'), 'c');
  fs.writeFileSync(path.join(root, 'Documents', 'sub', 'd.md'), 'd');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'x.js'), 'x');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'y'), 'y');
  fs.writeFileSync(path.join(root, 'loose.zip'), 'z');
  return root;
}

describe('file-map-overview scan', () => {
  it('BFS with depth, exclude and hidden handling, ext histogram', () => {
    const root = makeTree();
    const cfg = normalizeConfig(null, '/nonexistent-home');
    const out = scanStructure({ fsx: fs }, { roots: [root], depth: 2, excludePatterns: cfg.excludePatterns });
    const byPath = new Map(out.nodes.map(n => [n.p, n]));

    const rootNode = byPath.get(root);
    assert.equal(rootNode.d, 0);
    assert.equal(rootNode.files, 1, 'loose.zip only — hidden skipped');
    assert.equal(rootNode.dirs, 2, 'Documents + node_modules counted (hidden skipped)');

    const docs = byPath.get(path.join(root, 'Documents'));
    assert.equal(docs.files, 3);
    assert.deepEqual(docs.ext, { pdf: 2, txt: 1 });
    assert.ok(byPath.has(path.join(root, 'Documents', 'sub')), 'depth 2 reaches sub');

    assert.ok(!byPath.has(path.join(root, 'node_modules')), 'excluded tree gets no node');
    assert.ok(out.excludedHits.includes(path.join(root, 'node_modules')));
    assert.ok(!byPath.has(path.join(root, '.hidden')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('nodeCap truncates the scan', () => {
    const root = makeTree();
    const out = scanStructure({ fsx: fs }, { roots: [root], depth: 3, excludePatterns: [], nodeCap: 1 });
    assert.equal(out.nodes.length, 1);
    assert.equal(out.truncated, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('file-map-overview sizes + cache', () => {
  it('parseDuKb and mergeSizes', () => {
    assert.equal(parseDuKb('123456\t/Users/x/Documents\n'), 123456);
    assert.equal(parseDuKb('garbage'), null);
    const nodes = [{ p: '/a', kb: null }, { p: '/b', kb: null }];
    mergeSizes(nodes, new Map([['/a', 42]]));
    assert.equal(nodes[0].kb, 42);
    assert.equal(nodes[1].kb, null);
  });

  it('cache freshness honors TTL and scope', () => {
    const cache = { generated_at: new Date(NOW - 3600 * 1000).toISOString(), roots: ['/r'], depth: 3 };
    assert.equal(isCacheFresh(cache, 24, NOW), true);
    assert.equal(isCacheFresh(cache, 0.5, NOW), false, 'older than TTL');
    assert.equal(isCacheFresh(null, 24, NOW), false);
    assert.equal(cacheMatchesScope(cache, ['/r'], 3), true);
    assert.equal(cacheMatchesScope(cache, ['/other'], 3), false);
    assert.equal(cacheMatchesScope(cache, ['/r'], 2), false);
  });
});

describe('file-map-overview render', () => {
  const overview = {
    generated_at: '2026-07-18T00:00:00.000Z',
    duration_ms: 2000,
    roots: ['/home/u'],
    depth: 2,
    nodes: [
      { p: '/home/u', d: 0, dirs: 2, files: 1, ext: { zip: 1 }, mtimeMs: NOW, kb: 2000000 },
      { p: '/home/u/Big', d: 1, dirs: 0, files: 10, ext: { mov: 10 }, mtimeMs: NOW, kb: 1500000 },
      { p: '/home/u/Small', d: 1, dirs: 1, files: 2, ext: { md: 2 }, mtimeMs: null, kb: 100 },
      { p: '/home/u/Small/sub', d: 2, dirs: 0, files: 1, ext: {}, mtimeMs: null, kb: null },
    ],
    excluded_hits: ['/home/u/node_modules'],
  };

  it('renders tree sorted by size with ~ shortening and footers', () => {
    const md = renderOverviewMarkdown(overview, { home: '/home/u' });
    assert.match(md, /# File Map — ~/);
    assert.ok(md.indexOf('~/Big') < md.indexOf('~/Small'), 'bigger dir listed first');
    assert.match(md, /~\/Big — 1\.4 GB · 10 files/);
    assert.match(md, /top: mov×10/);
    assert.match(md, /~\/Small\/sub — \?/, 'unknown size renders as ?');
    assert.match(md, /Excluded trees .*node_modules/);
    assert.match(md, /Hidden \(dot\) entries are skipped/);
  });

  it('folds beyond perLevel and respects the byte budget', () => {
    const many = {
      ...overview,
      nodes: [
        overview.nodes[0],
        ...Array.from({ length: 30 }, (_, i) => ({ p: `/home/u/d${i}`, d: 1, dirs: 0, files: 1, ext: {}, mtimeMs: null, kb: 30 - i })),
      ],
    };
    const md = renderOverviewMarkdown(many, { home: '/home/u', perLevel: 5 });
    assert.match(md, /\+25 more dirs/);
    const tiny = renderOverviewMarkdown(many, { home: '/home/u', budgetBytes: 200 });
    assert.ok(tiny.length < 400);
    assert.match(tiny, /map truncated at size budget/);
  });
});

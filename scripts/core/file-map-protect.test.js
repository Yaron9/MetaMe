'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchGlob, findProtectedMatch, isWithinRoots, validatePathSyntax, checkPath, validateCandidates,
} = require('./file-map-protect');
const { normalizeConfig } = require('./file-map-config');

const HOME = '/home/u';
const NOW = Date.parse('2026-07-18T00:00:00Z');
const OLD_MTIME = NOW - 100 * 24 * 3600 * 1000;

function fileStat(over = {}) {
  return {
    isSymbolicLink: () => false,
    isDirectory: () => false,
    size: 1024,
    mtimeMs: OLD_MTIME,
    ino: 42,
    dev: 7,
    ...over,
  };
}

function ioFor(stats, { realpath } = {}) {
  return {
    lstatSync: (p) => { if (stats[p]) return stats[p]; throw new Error('ENOENT'); },
    realpathSync: (p) => (realpath && realpath[p]) || p,
    now: () => NOW,
  };
}

describe('file-map-protect glob', () => {
  it('* stays within a segment, ** crosses segments', () => {
    assert.ok(matchGlob('/home/u/*', '/home/u/.zshrc'));
    assert.ok(!matchGlob('/home/u/*', '/home/u/Downloads/x.dmg'));
    assert.ok(matchGlob('**/.git/**', '/home/u/proj/.git/config'));
    assert.ok(matchGlob('**/.git', '/home/u/proj/.git'));
    assert.ok(!matchGlob('**/.git', '/home/u/proj/.github'));
    assert.ok(matchGlob('**/*.photoslibrary/**', '/home/u/Pictures/Fotos.photoslibrary/db'));
  });

  it('X/** also protects X itself', () => {
    assert.equal(findProtectedMatch('/System', ['/System/**']), '/System/**');
    assert.equal(findProtectedMatch('/System/Library/x', ['/System/**']), '/System/**');
    assert.equal(findProtectedMatch('/Sys', ['/System/**']), null);
  });

  it('roots containment is strict — the root itself is not inside', () => {
    assert.ok(isWithinRoots('/home/u/Downloads/x', ['/home/u']));
    assert.ok(!isWithinRoots('/home/u', ['/home/u']));
    assert.ok(!isWithinRoots('/home/uu/x', ['/home/u']), 'prefix must respect path boundaries');
  });

  it('rejects ambiguous and traversal-shaped paths before filesystem access', () => {
    for (const value of ['relative/path', '/home/u/a/../b', '/home/u/./b', '/home/u/x\0y', '/home/u//b']) {
      assert.equal(validatePathSyntax(value).ok, false, `${JSON.stringify(value)} must be rejected`);
    }
    assert.deepEqual(validatePathSyntax('/home/u/Downloads/a.zip'), { ok: true });
  });
});

describe('file-map-protect checkPath', () => {
  const cfg = normalizeConfig(null, HOME);

  it('accepts an old regular file inside roots', () => {
    const p = `${HOME}/Downloads/old.dmg`;
    const res = checkPath(p, cfg, ioFor({ [p]: fileStat() }));
    assert.equal(res.ok, true);
    assert.equal(res.stat.inode, 42);
  });

  it('rejects: relative, missing, symlink, escaping realpath, protected, recent', () => {
    const cases = [
      ['relative/path', ioFor({}), 'not-absolute'],
      [`${HOME}/gone`, ioFor({}), 'missing'],
      [`${HOME}/Downloads/link`, ioFor({ [`${HOME}/Downloads/link`]: fileStat({ isSymbolicLink: () => true }) }), 'symlink'],
      [`${HOME}/Downloads/esc`, ioFor({ [`${HOME}/Downloads/esc`]: fileStat() }, { realpath: { [`${HOME}/Downloads/esc`]: '/etc/passwd' } }), 'symlink-ancestor'],
      [`${HOME}/Library/Caches/x`, ioFor({ [`${HOME}/Library/Caches/x`]: fileStat() }), `protected:${HOME}/Library/**`],
      [`${HOME}/.zshrc`, ioFor({ [`${HOME}/.zshrc`]: fileStat() }), `protected:${HOME}/*`],
      [`${HOME}/proj/.git/config`, ioFor({ [`${HOME}/proj/.git/config`]: fileStat() }), 'protected:**/.git/**'],
      [`${HOME}/Downloads/new.txt`, ioFor({ [`${HOME}/Downloads/new.txt`]: fileStat({ mtimeMs: NOW - 1000 }) }), 'recent-mtime:<14d'],
    ];
    for (const [p, io, rule] of cases) {
      const res = checkPath(p, cfg, io);
      assert.equal(res.ok, false, `${p} must be rejected`);
      assert.equal(res.rule, rule);
    }
  });

  it('realpath that maps into a protected tree is caught', () => {
    const p = `${HOME}/Downloads/alias`;
    const io = ioFor({ [p]: fileStat() }, { realpath: { [p]: `${HOME}/Library/Data/real` } });
    const res = checkPath(p, cfg, io);
    assert.equal(res.ok, false);
    assert.equal(res.rule, 'symlink-ancestor');
  });
});

describe('file-map-protect validateCandidates', () => {
  it('splits accepted/rejected, collapses duplicates, skips non-strings', () => {
    const cfg = normalizeConfig(null, HOME);
    const ok = `${HOME}/Downloads/a.zip`;
    const bad = `${HOME}/.ssh/id_rsa`;
    const io = ioFor({ [ok]: fileStat(), [bad]: fileStat() });
    const out = validateCandidates([ok, bad, ok, 42, null], cfg, io);
    assert.equal(out.accepted.length, 1);
    assert.equal(out.accepted[0].path, ok);
    assert.equal(out.accepted[0].device, 7);
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].rule, /protected:/);
  });
});

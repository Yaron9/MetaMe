'use strict';

const path = require('path');

/**
 * file-map-protect.js — the hard safety net in front of every destructive
 * candidate. Pure logic: all fs access is injected.
 *
 * Rules run in fixed order, first hit wins:
 *   absolute path → lstat (symlinks rejected outright) → realpath →
 *   roots containment (both given and real path) → protected globs
 *   (both given and real path) → recent-mtime guard.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Compile a glob supporting only `**` (crosses /) and `*` (within segment). */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchGlob(pattern, p) {
  return globToRegExp(pattern).test(p);
}

/** Returns the matching pattern, or null. `X/**` also protects X itself. */
function findProtectedMatch(p, patterns) {
  for (const pattern of patterns) {
    if (matchGlob(pattern, p)) return pattern;
    if (pattern.endsWith('/**') && p === pattern.slice(0, -3)) return pattern;
  }
  return null;
}

/** Directory (or its contents) matches an exclude glob → skip descending. */
function shouldExclude(p, patterns) {
  const probe = p + '/';
  return patterns.some(pat => matchGlob(pat, probe) || matchGlob(pat, p));
}

/** Strictly inside a root — the root itself is never a valid candidate. */
function isWithinRoots(p, roots) {
  return roots.some(root => {
    const base = root.endsWith('/') ? root : root + '/';
    return p !== root && p.startsWith(base);
  });
}

/** Reject ambiguous spellings before any filesystem resolution occurs. */
function validatePathSyntax(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, rule: 'not-absolute' };
  if (p.includes('\0')) return { ok: false, rule: 'nul-byte' };
  const parts = p.split('/');
  if (parts.includes('.') || parts.includes('..')) return { ok: false, rule: 'dot-component' };
  if (path.normalize(p) !== p) return { ok: false, rule: 'not-normalized' };
  return { ok: true };
}

/**
 * Validate one candidate path against the config.
 * io: { lstatSync, realpathSync, now } — now() in epoch ms.
 * Returns { ok:true, stat:{size,mtimeMs,inode,isDirectory} } or { ok:false, rule }.
 */
function checkPath(p, cfg, io) {
  const syntax = validatePathSyntax(p);
  if (!syntax.ok) return syntax;
  let st;
  try { st = io.lstatSync(p); } catch { return { ok: false, rule: 'missing' }; }
  if (st.isSymbolicLink()) return { ok: false, rule: 'symlink' };
  let real;
  try { real = io.realpathSync(p); } catch { return { ok: false, rule: 'unresolvable' }; }
  if (real !== p) return { ok: false, rule: 'symlink-ancestor' };
  if (!isWithinRoots(p, cfg.roots) || !isWithinRoots(real, cfg.roots)) {
    return { ok: false, rule: 'outside-roots' };
  }
  const hit = findProtectedMatch(p, cfg.protectedPatterns) || findProtectedMatch(real, cfg.protectedPatterns);
  if (hit) return { ok: false, rule: `protected:${hit}` };
  if (io.now() - st.mtimeMs < cfg.protectRecentDays * DAY_MS) {
    return { ok: false, rule: `recent-mtime:<${cfg.protectRecentDays}d` };
  }
  return {
    ok: true,
    stat: {
      size: st.size,
      mtimeMs: st.mtimeMs,
      inode: st.ino,
      device: st.dev,
      isDirectory: st.isDirectory(),
      canonicalPath: real,
    },
  };
}

/** Validate a batch; duplicates are collapsed. */
function validateCandidates(paths, cfg, io) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const p of paths) {
    if (typeof p !== 'string' || seen.has(p)) continue;
    seen.add(p);
    const res = checkPath(p, cfg, io);
    if (res.ok) accepted.push({ path: res.stat.canonicalPath, displayPath: p, ...res.stat });
    else rejected.push({ path: p, rule: res.rule });
  }
  return { accepted, rejected };
}

module.exports = {
  matchGlob,
  shouldExclude,
  findProtectedMatch,
  isWithinRoots,
  validatePathSyntax,
  checkPath,
  validateCandidates,
  _internal: { globToRegExp },
};

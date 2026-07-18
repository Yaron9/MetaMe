'use strict';

/**
 * file-map-spotlight.js — mdfind/mdls argument builders and output parsers.
 * Pure: never spawns; the server layer owns process execution.
 *
 * Spotlight quirks encoded here:
 *  - `kMDItemLastUsedDate < $time.today(-N)` silently skips items where the
 *    attribute is null, so stale queries must OR an existence negation
 *    (`!= "*"`) and callers must treat the two populations as different
 *    confidence levels (confirmed_stale vs never_recorded).
 *  - mdfind writes parser noise to stderr; callers must read stdout only.
 *  - APFS atime is unreliable; kMDItemLastUsedDate (LaunchServices opens)
 *    is the only trustworthy "last used" signal on macOS.
 */

const KIND_QUERIES = {
  document: 'kMDItemContentTypeTree == "public.composite-content"',
  image: 'kMDItemContentTypeTree == "public.image"',
  audio: 'kMDItemContentTypeTree == "public.audio"',
  video: 'kMDItemContentTypeTree == "public.movie"',
  archive: 'kMDItemContentTypeTree == "public.archive"',
  code: 'kMDItemContentTypeTree == "public.source-code"',
  app: 'kMDItemContentTypeTree == "com.apple.application"',
  folder: 'kMDItemContentTypeTree == "public.folder"',
};

const MB = 1024 * 1024;

function escapeQueryValue(v) {
  return String(v).replace(/["\\]/g, '');
}

function buildQueryExpression({ query, name, kind, modifiedWithinDays, minSizeMb }) {
  const parts = [];
  if (query) {
    const q = String(query);
    if (q.includes('kMDItem')) {
      parts.push(`(${q})`); // raw Spotlight expression passthrough
    } else {
      const v = escapeQueryValue(q);
      parts.push(`(kMDItemDisplayName == "*${v}*"cd || kMDItemTextContent == "${v}"cd)`);
    }
  }
  if (name) parts.push(`kMDItemFSName == "*${escapeQueryValue(name)}*"cd`);
  if (kind && KIND_QUERIES[kind]) parts.push(KIND_QUERIES[kind]);
  if (Number.isFinite(modifiedWithinDays) && modifiedWithinDays > 0) {
    parts.push(`kMDItemFSContentChangeDate >= $time.today(-${Math.ceil(modifiedWithinDays)})`);
  }
  if (Number.isFinite(minSizeMb) && minSizeMb > 0) {
    parts.push(`kMDItemFSSize > ${Math.floor(minSizeMb * MB)}`);
  }
  return parts.join(' && ');
}

/**
 * Build mdfind argv. Single-filter name searches use `-name` (fast path);
 * anything structured becomes a query expression. Returns null when there is
 * nothing to search for.
 */
function buildSearchArgs(opts) {
  const args = [];
  if (opts.root) args.push('-onlyin', opts.root);
  if (opts.countOnly) args.push('-count'); else args.push('-0');
  const structured = opts.query || opts.kind || opts.modifiedWithinDays > 0 || opts.minSizeMb > 0;
  if (opts.name && !structured) {
    args.push('-name', String(opts.name));
    return args;
  }
  const expr = buildQueryExpression(opts);
  if (!expr) return null;
  args.push(expr);
  return args;
}

function buildLargeQuery({ minSizeMb }) {
  return `kMDItemFSSize > ${Math.floor((Number(minSizeMb) || 100) * MB)}`;
}

function buildStaleQuery({ unusedDays, minSizeMb }) {
  const days = Math.max(1, Math.ceil(Number(unusedDays) || 180));
  const size = `kMDItemFSSize > ${Math.floor((Number(minSizeMb) || 10) * MB)}`;
  return `${size} && (kMDItemLastUsedDate < $time.today(-${days}) || kMDItemLastUsedDate != "*")`;
}

/** Parse mdfind output (NUL-separated with -0, newline otherwise). */
function parsePathList(stdout, { nul = true } = {}) {
  if (!stdout) return [];
  return String(stdout).split(nul ? '\0' : '\n').map(s => nul ? s : s.trim()).filter(Boolean);
}

/**
 * Parse `mdls -raw -nullMarker (null)` output for ONE attribute across many
 * files: values are NUL-separated, one per file, in argument order.
 */
function parseMdlsRaw(stdout, count) {
  const values = String(stdout || '').split('\0');
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = i < values.length ? values[i].trim() : '';
    out.push(!v || v === '(null)' ? null : v);
  }
  return out;
}

/** Spotlight dates look like `2026-07-17 00:58:18 +0000` → ISO string or null. */
function parseSpotlightDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseCount(stdout) {
  const n = parseInt(String(stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  KIND_QUERIES,
  buildQueryExpression,
  buildSearchArgs,
  buildLargeQuery,
  buildStaleQuery,
  parsePathList,
  parseMdlsRaw,
  parseSpotlightDate,
  parseCount,
  _internal: { escapeQueryValue },
};

'use strict';

/**
 * file-map-dupes.js — duplicate detection. Pure logic: fs and hashers are
 * injected; the server layer owns real hashing and fclones execution.
 *
 * Built-in engine is the classic three-stage funnel — size buckets → head
 * hash → full hash — so full-content hashing only ever runs on files that
 * already collide twice. Files above fullHashMaxBytes skip the full pass and
 * are reported with confidence 'probable' instead of 'confirmed'.
 *
 * parseFclonesJson() adapts `fclones group --format json` output to the same
 * group shape, so the server can prefer fclones when it is installed.
 */

const { shouldExclude } = require('./file-map-protect');

/** Walk root collecting candidate files ≥ minSizeBytes (hidden entries and excluded trees skipped). */
function collectCandidates({ fsx }, { root, minSizeBytes, excludePatterns, maxFiles = 50000 }) {
  const files = [];
  let seen = 0;
  const stack = [root.endsWith('/') ? root.slice(0, -1) : root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fsx.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!shouldExclude(p, excludePatterns)) stack.push(p);
      } else if (e.isFile()) {
        if (++seen > maxFiles) return { files, truncated: true };
        let st;
        try { st = fsx.statSync(p); } catch { continue; }
        if (st.size >= minSizeBytes) files.push({ path: p, size: st.size });
      }
    }
  }
  return { files, truncated: false };
}

/** Size buckets that actually collide (≥2 files). */
function groupBySize(files) {
  const bySize = new Map();
  for (const f of files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f.path);
  }
  for (const [size, paths] of bySize) {
    if (paths.length < 2) bySize.delete(size);
  }
  return bySize;
}

function pushGroup(groups, size, files, confidence) {
  groups.push({ size, count: files.length, wasted_bytes: size * (files.length - 1), confidence, files });
}

/**
 * Resolve size buckets into duplicate groups.
 * hashers: { hashHead(path, bytes) → Promise<hex>, hashFull(path) → Promise<hex> }.
 * Files whose hashing fails are silently dropped from their bucket.
 */
async function buildDuplicateGroups(sizeGroups, hashers, { headBytes = 65536, fullHashMaxBytes = 512 * 1024 * 1024 } = {}) {
  const groups = [];
  for (const [size, paths] of sizeGroups) {
    const byHead = new Map();
    for (const p of paths) {
      let h;
      try { h = await hashers.hashHead(p, headBytes); } catch { continue; }
      if (!byHead.has(h)) byHead.set(h, []);
      byHead.get(h).push(p);
    }
    for (const cand of byHead.values()) {
      if (cand.length < 2) continue;
      if (size > fullHashMaxBytes) {
        pushGroup(groups, size, cand, 'probable');
        continue;
      }
      const byFull = new Map();
      for (const p of cand) {
        let h;
        try { h = await hashers.hashFull(p); } catch { continue; }
        if (!byFull.has(h)) byFull.set(h, []);
        byFull.get(h).push(p);
      }
      for (const dup of byFull.values()) {
        if (dup.length >= 2) pushGroup(groups, size, dup, 'confirmed');
      }
    }
  }
  groups.sort((a, b) => b.wasted_bytes - a.wasted_bytes);
  return groups;
}

/** Adapt `fclones group --format json` to the built-in group shape; null on unparseable input. */
function parseFclonesJson(stdout) {
  let data;
  try { data = JSON.parse(stdout); } catch { return null; }
  const rawGroups = Array.isArray(data) ? data : (data && Array.isArray(data.groups) ? data.groups : null);
  if (!rawGroups) return null;
  const groups = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const files = (Array.isArray(g.files) ? g.files : [])
      .map(f => (typeof f === 'string' ? f : f && (f.path || f.file)))
      .filter(Boolean);
    if (files.length < 2) continue;
    const size = Number(g.file_len ?? g.len ?? g.size) || 0;
    pushGroup(groups, size, files, 'confirmed');
  }
  groups.sort((a, b) => b.wasted_bytes - a.wasted_bytes);
  return groups;
}

module.exports = { collectCandidates, groupBySize, buildDuplicateGroups, parseFclonesJson, _internal: { pushGroup } };

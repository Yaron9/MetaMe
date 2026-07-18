'use strict';

/**
 * file-map-overview.js — "the home map": a compact structural overview of the
 * user's file landscape that an agent can load whole into context. Pure
 * logic: fs is injected, du execution stays in the server layer.
 *
 * Two-layer scan contract:
 *  - structure (cheap): BFS to `depth`, per-directory entry counts + extension
 *    histogram + dir mtime; excluded trees recorded but not descended; hidden
 *    (dot) entries skipped — consistent with Spotlight's blind spot.
 *  - sizes (expensive): the server runs `du -sk` for shallow nodes under a
 *    time budget and merges results in via mergeSizes(); missing sizes stay
 *    null rather than blocking the map.
 */

const { shouldExclude } = require('./file-map-protect');

function topExt(counts, n) {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n)
  );
}

function scanStructure({ fsx }, { roots, depth, excludePatterns, perDirCap = 5000, nodeCap = 4000 }) {
  const nodes = [];
  const excludedHits = [];
  let truncated = false;
  const queue = roots.map(r => ({ p: r.endsWith('/') ? r.slice(0, -1) : r, d: 0 }));
  while (queue.length) {
    const { p, d } = queue.shift();
    if (nodes.length >= nodeCap) { truncated = true; break; }
    let entries;
    try { entries = fsx.readdirSync(p, { withFileTypes: true }); } catch { continue; }
    const sampled = entries.length > perDirCap;
    const slice = sampled ? entries.slice(0, perDirCap) : entries;
    let files = 0;
    let dirs = 0;
    const ext = {};
    const subdirs = [];
    for (const e of slice) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        dirs++;
        const child = `${p}/${e.name}`;
        if (shouldExclude(child, excludePatterns)) { excludedHits.push(child); continue; }
        if (d < depth) subdirs.push(child);
      } else if (e.isFile()) {
        files++;
        const dot = e.name.lastIndexOf('.');
        const ex = dot > 0 ? e.name.slice(dot + 1).toLowerCase().slice(0, 8) : '';
        if (ex) ext[ex] = (ext[ex] || 0) + 1;
      }
    }
    let mtimeMs = null;
    try { mtimeMs = fsx.statSync(p).mtimeMs; } catch { /* keep null */ }
    const node = { p, d, dirs, files, ext: topExt(ext, 5), mtimeMs, kb: null };
    if (sampled) node.sampled = true;
    nodes.push(node);
    for (const s of subdirs) queue.push({ p: s, d: d + 1 });
  }
  return { nodes, excludedHits, truncated };
}

/** `du -sk <dir>` → KB, or null. */
function parseDuKb(stdout) {
  const kb = parseInt(String(stdout || '').trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) ? kb : null;
}

function mergeSizes(nodes, kbByPath) {
  for (const n of nodes) {
    if (kbByPath.has(n.p)) n.kb = kbByPath.get(n.p);
  }
}

function isCacheFresh(cache, ttlHours, nowMs) {
  if (!cache || !cache.generated_at) return false;
  const age = nowMs - Date.parse(cache.generated_at);
  return Number.isFinite(age) && age >= 0 && age < ttlHours * 3600 * 1000;
}

function cacheMatchesScope(cache, roots, depth) {
  return !!cache && cache.depth === depth
    && JSON.stringify(cache.roots) === JSON.stringify(roots);
}

function fmtKb(kb) {
  if (kb == null) return '?';
  if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(1) + ' GB';
  if (kb >= 1024) return (kb / 1024).toFixed(0) + ' MB';
  return kb + ' KB';
}

function fmtNode(node, short) {
  const name = short(node.p);
  const bits = [`${fmtKb(node.kb)}`, `${node.files} files`, `${node.dirs} dirs`];
  const ext = Object.entries(node.ext || {}).map(([k, v]) => `${k}×${v}`).join(', ');
  if (ext) bits.push(`top: ${ext}`);
  if (node.mtimeMs) bits.push(`mtime ${new Date(node.mtimeMs).toISOString().slice(0, 10)}`);
  if (node.sampled) bits.push('(sampled)');
  return `${name} — ${bits.join(' · ')}`;
}

/**
 * Render the overview as markdown within a byte budget: children sorted by
 * size desc (unknown sizes last), top `perLevel` shown per directory, the
 * rest folded into a single "+N more" line.
 */
function renderOverviewMarkdown(overview, { budgetBytes = 8192, home = '', perLevel = 20 } = {}) {
  const short = p => (home && (p === home || p.startsWith(home + '/'))) ? '~' + p.slice(home.length) : p;
  const byParent = new Map();
  for (const n of overview.nodes) {
    if (n.d === 0) continue;
    const parent = n.p.slice(0, n.p.lastIndexOf('/'));
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(n);
  }
  const sortChildren = (list) => [...list].sort((a, b) => {
    if (a.kb != null || b.kb != null) return (b.kb || 0) - (a.kb || 0);
    return (b.files + b.dirs) - (a.files + a.dirs);
  });

  const lines = [];
  let used = 0;
  let overBudget = false;
  const push = (line) => {
    if (overBudget) return false;
    if (used + line.length + 1 > budgetBytes) { overBudget = true; return false; }
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  push(`# File Map — ${overview.roots.map(short).join(', ')} (generated ${overview.generated_at}, scan ${Math.round((overview.duration_ms || 0) / 1000)}s)`);
  const renderDir = (node, indent) => {
    if (overBudget) return;
    const children = sortChildren(byParent.get(node.p) || []);
    const shown = children.slice(0, perLevel);
    for (const child of shown) {
      if (!push(`${'  '.repeat(indent)}- ${fmtNode(child, short)}`)) return;
      renderDir(child, indent + 1);
    }
    if (children.length > shown.length) {
      const rest = children.slice(perLevel);
      const restKb = rest.reduce((s, c) => s + (c.kb || 0), 0);
      push(`${'  '.repeat(indent)}- … +${rest.length} more dirs (${fmtKb(restKb)})`);
    }
  };
  for (const root of overview.nodes.filter(n => n.d === 0)) {
    push(`## ${fmtNode(root, short)}`);
    renderDir(root, 0);
  }
  if (overview.excluded_hits && overview.excluded_hits.length) {
    push(`_Excluded trees (not descended): ${overview.excluded_hits.length} (e.g. ${overview.excluded_hits.slice(0, 3).map(short).join(', ')})_`);
  }
  push('_Hidden (dot) entries are skipped — same blind spot as Spotlight. Sizes come from du and may be partial._');
  if (overBudget) lines.push('_…map truncated at size budget — use file_overview with a narrower root for detail._');
  return lines.join('\n');
}

module.exports = {
  scanStructure,
  parseDuKb,
  mergeSizes,
  isCacheFresh,
  cacheMatchesScope,
  renderOverviewMarkdown,
  _internal: { shouldExclude, topExt, fmtKb, fmtNode },
};

#!/usr/bin/env node

/**
 * qmd-client.js — QMD (Hybrid Search Engine) integration for MetaMe
 *
 * Optional dependency: https://github.com/tobi/qmd
 * Install: npm install -g @tobilu/qmd
 *
 * When QMD is present:
 *   - Facts are written as markdown files to ~/.metame/facts-docs/
 *   - searchFacts() uses QMD's `query` MCP tool (BM25 + vector + rerank)
 *   - QMD HTTP daemon stays running for fast model reuse
 *
 * When QMD is absent: all calls are no-ops; caller falls back to FTS5.
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const FACTS_DOCS_DIR = path.join(HOME, '.metame', 'facts-docs');
const QMD_URL = 'http://localhost:8181';
const COLLECTION = 'metame-facts';
const { AbortSignal } = globalThis;
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

// ── Availability ───────────────────────────────────────────────────────────

let _available = null;
function isAvailable() {
  if (_available !== null) return _available;
  try {
    execSync('which qmd', { stdio: 'pipe', timeout: 2000 });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

async function isDaemonRunning() {
  if (!isAvailable()) return false;
  try {
    const res = await fetch(`${QMD_URL}/health`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Daemon lifecycle ───────────────────────────────────────────────────────

/**
 * Start QMD HTTP daemon if not already running.
 * Returns true if daemon is up after this call.
 */
async function startDaemon() {
  if (!isAvailable()) return false;
  if (await isDaemonRunning()) return true;
  try {
    resetMcpSession();
    execSync('qmd mcp --http --daemon', { stdio: 'ignore', timeout: 8000 });
    // Give it a moment to bind
    await new Promise(r => setTimeout(r, 1000));
    return isDaemonRunning();
  } catch {
    return false;
  }
}

/**
 * Stop QMD HTTP daemon. Non-fatal.
 */
function stopDaemon() {
  if (!isAvailable()) return;
  resetMcpSession();
  try {
    execSync('qmd mcp stop', { stdio: 'ignore', timeout: 3000 });
  } catch { /* ignore */ }
}

// ── Collection setup ───────────────────────────────────────────────────────

/**
 * Ensure facts-docs/ directory and QMD collection exist.
 * Safe to call multiple times.
 */
function ensureCollection() {
  if (!isAvailable()) return;
  fs.mkdirSync(FACTS_DOCS_DIR, { recursive: true });
  try {
    // --name is idempotent: adding an already-named collection is a no-op
    execSync(`qmd collection add "${FACTS_DOCS_DIR}" --name "${COLLECTION}"`, {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch { /* already exists or QMD error, both ok */ }
}

// ── Upsert ─────────────────────────────────────────────────────────────────

/**
 * Convert a fact object to markdown content.
 * Filename = {id}.md, so the ID is recoverable from search results.
 */
function factToMd(fact) {
  const tags = Array.isArray(fact.tags) ? fact.tags.join(', ') : '';
  const date = (fact.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  return [
    `# [${fact.relation}] ${fact.entity}`,
    '',
    fact.value,
    '',
    `Tags: ${tags}`,
    `Project: ${fact.project || 'unknown'}`,
    `Date: ${date}`,
  ].join('\n');
}

/**
 * Write facts as markdown files and trigger async re-embed.
 * facts must be the array returned by memory.saveFacts (with id field).
 * Non-fatal: any error is silently ignored.
 */
function upsertFacts(facts) {
  if (!isAvailable() || !Array.isArray(facts) || facts.length === 0) return;
  try {
    ensureCollection();
    for (const f of facts) {
      if (!f.id) continue;
      fs.writeFileSync(path.join(FACTS_DOCS_DIR, `${f.id}.md`), factToMd(f), 'utf8');
    }
    // Incremental embed: detach so it doesn't block caller
    const child = spawn('qmd', ['embed'], {
      detached: true,
      stdio: 'ignore',
      cwd: HOME,
    });
    child.unref();
  } catch { /* non-fatal */ }
}

// ── Search ─────────────────────────────────────────────────────────────────

let _mcpSessionId = null;
let _mcpSessionPromise = null;

function resetMcpSession() {
  _mcpSessionId = null;
  _mcpSessionPromise = null;
}

async function initializeMcpSession() {
  const response = await fetch(`${QMD_URL}/mcp`, {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'metame', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;

  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) return null;
  const ready = await fetch(`${QMD_URL}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(5000),
  });
  if (!ready.ok) return null;
  _mcpSessionId = sessionId;
  return sessionId;
}

async function getMcpSessionId() {
  if (_mcpSessionId) return _mcpSessionId;
  if (!_mcpSessionPromise) {
    _mcpSessionPromise = initializeMcpSession().finally(() => {
      _mcpSessionPromise = null;
    });
  }
  return _mcpSessionPromise;
}

async function callMcpTool(payload, retry = true) {
  const sessionId = await getMcpSessionId();
  if (!sessionId) return null;
  const response = await fetch(`${QMD_URL}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (retry && (response.status === 400 || response.status === 404)) {
    resetMcpSession();
    return callMcpTool(payload, false);
  }
  return response;
}

/**
 * Search via QMD HTTP daemon (MCP JSON-RPC).
 * Returns array of fact IDs, or null if unavailable.
 */
async function searchViaHttp(query, limit) {
  try {
    const res = await callMcpTool({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: buildSearchArguments(query, limit),
      },
    });
    if (!res?.ok) return null;
    const data = await res.json();
    return parseSearchResult(data?.result);
  } catch {
    return null;
  }
}

function buildSearchArguments(query, limit) {
  return {
    searches: [
      { type: 'lex', query },
      { type: 'vec', query },
    ],
    collections: [COLLECTION],
    intent: 'Find MetaMe remembered facts relevant to the user request.',
    limit,
    minScore: 0.3,
  };
}

/**
 * Search via QMD CLI (slower; models may not be warm).
 * Returns array of fact IDs, or null on failure.
 */
function searchViaCli(query, limit) {
  if (!isAvailable()) return null;
  try {
    // Use `qmd query` for hybrid search (BM25 + vector + rerank, requires models)
    // Fall back to `qmd search` (BM25 only) if query fails (e.g. models not yet downloaded)
    let raw;
    try {
      raw = execSync(
        `qmd query ${JSON.stringify(query)} -c "${COLLECTION}" --json -n ${limit}`,
        { timeout: 30000, encoding: 'utf8', stdio: 'pipe' }
      );
    } catch {
      raw = execSync(
        `qmd search ${JSON.stringify(query)} -c "${COLLECTION}" --json -n ${limit}`,
        { timeout: 8000, encoding: 'utf8', stdio: 'pipe' }
      );
    }
    return parseSearchResult(raw);
  } catch {
    return null;
  }
}

/**
 * Parse QMD JSON output → array of fact IDs extracted from filenames.
 *
 * CLI output format: [{"docid": "#abc123", "score": 0.85, "file": "path/to/f-xxx.md"}, ...]
 * MCP HTTP format: wrapped in data.result.content as stringified JSON
 */
function extractSearchItems(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    if (raw.every(item => item && typeof item === 'object' && ('file' in item || 'path' in item))) {
      return raw;
    }
    for (const item of raw) {
      const nested = extractSearchItems(item?.text ?? item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof raw === 'object') {
    return extractSearchItems(raw.results)
      || extractSearchItems(raw.structuredContent)
      || extractSearchItems(raw.result)
      || extractSearchItems(raw.content);
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  try {
    return extractSearchItems(JSON.parse(text));
  } catch {
    const start = text.lastIndexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return null;
    return extractSearchItems(JSON.parse(text.slice(start, end + 1)));
  }
}

function parseSearchResult(raw) {
  try {
    const items = extractSearchItems(raw);
    if (!items?.length) return null;

    const ids = [];
    for (const item of items) {
      // QMD returns { file: "qmd://metame-facts/f-abc12345-ts-rand.md", score, docid }
      const filePath = item.file || item.path || '';
      // Strip qmd:// virtual path prefix, then get basename
      const stripped = filePath.replace(/^qmd:\/\/[^/]+\//, '');
      const basename = path.basename(stripped, '.md');
      if (basename.startsWith('f-')) {
        ids.push(basename);
      }
    }
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Top-level search: try HTTP daemon → CLI → return null (caller uses FTS5).
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<string[]|null>} Array of fact IDs, or null
 */
async function search(query, limit = 5) {
  if (!isAvailable()) return null;

  // Try HTTP daemon first (models warm, fast)
  if (await isDaemonRunning()) {
    const ids = await searchViaHttp(query, limit);
    if (ids) return ids;
  }

  // Fall back to CLI
  return searchViaCli(query, limit);
}

module.exports = {
  isAvailable,
  isDaemonRunning,
  startDaemon,
  stopDaemon,
  ensureCollection,
  upsertFacts,
  search,
  _internal: {
    buildSearchArguments,
    parseSearchResult,
    resetMcpSession,
    searchViaHttp,
  },
};

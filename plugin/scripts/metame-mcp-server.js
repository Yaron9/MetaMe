#!/usr/bin/env node

'use strict';

/**
 * metame-mcp-server.js — the universal consumption surface (plan P4).
 *
 * Any MCP-capable agent (Claude Code, Codex, Gemini CLI, Cursor, …) can mount
 * MetaMe's memory / profile / skills through this single stdio server:
 *
 *   claude mcp add metame -- node ~/.metame/metame-mcp-server.js
 *   # Codex: [mcp_servers.metame] command = "node", args = ["~/.metame/metame-mcp-server.js"]
 *
 * Tool semantics stay CommonJS and are shared by the narrow SDK transport
 * entrypoint (`metame-mcp-server-sdk.mjs`).  Keeping this module CommonJS
 * avoids migrating the repository's existing runtime while the official MCP
 * SDK owns production protocol framing and transport lifecycle.
 *
 * Every tool is a thin wrapper over an existing module; no memory logic lives
 * here. Writes go through memory-write's validation + candidate pipeline and
 * are tagged source `mcp` for auditability.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { assembleSearchResults, scopeKeys } = require('./core/cognitive-consumption');
const { toBoundedSourceRef } = require('./core/cognitive-effectiveness');
const { isTrustedAccess, resolveAccessContext } = require('./core/context-manifest');

const HOME = os.homedir();
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const AGENTS_DIR = path.join(HOME, '.metame', 'agents');
const DB_PATH = path.join(HOME, '.metame', 'memory.db');

// Kept only for the imported legacy handleMessage characterization seam. The
// executable path negotiates this through the official SDK server.
const PROTOCOL_VERSION = '2025-11-25';
const SERVER_INFO = { name: 'metame', version: '1.0.0' };

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search MetaMe long-term memory (facts + knowledge wiki) with hybrid FTS/vector ranking. Use proactively before acting when a task depends on project conventions, historical technical decisions, recurring failures, or prior experience. Returns summary-first references; open only necessary details with memory_get.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords, file names, topics)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        project: { type: 'string', description: 'Optional project filter' },
        max_chars: { type: 'number', description: 'Maximum serialized result characters (default 4000)' },
        host: { type: 'string', description: 'Optional consuming host name for audit' },
        agent_key: { type: 'string', description: 'Optional consuming agent key for audit' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: 'Open one necessary typed memory_search result by type and id. Records an opened consumption event without changing memory promotion counters. If the asset materially affects execution, call memory_feedback after outcome evidence exists.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['fact', 'wiki'] },
        id: { type: 'string' },
        project: { type: 'string' },
        trace_id: { type: 'string' },
        history: { type: 'boolean', description: 'For facts, explicitly return the supersession history instead of only the current value' },
        host: { type: 'string' },
        agent_key: { type: 'string' },
      },
      required: ['type', 'id', 'trace_id'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Assemble a budgeted recall context for a user message, exactly as MetaMe injects into its own agents (multi-mode retrieval, PII redaction, char budget). Use when you need "what does MetaMe remember relevant to this?"',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The user message or question to recall against' },
        project: { type: 'string', description: 'Optional project scope' },
        agent_key: { type: 'string', description: 'Optional agent scope for working-memory access' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_write',
    description: 'Persist a verified atomic fact into MetaMe memory (goes through validation and the candidate→active promotion pipeline; duplicates are skipped). Only write confirmed facts, never speculation.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity key like "Project.component"' },
        relation: { type: 'string', description: 'One of: tech_decision, bug_lesson, arch_convention, config_fact, config_change, workflow_rule, project_milestone' },
        value: { type: 'string', description: 'The fact, 20-300 chars' },
        confidence: { type: 'string', description: 'low | medium | high (default medium)' },
        project: { type: 'string', description: 'Project key (default *)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Up to 3 tags' },
      },
      required: ['entity', 'relation', 'value'],
    },
  },
  {
    name: 'memory_feedback',
    description: 'Record evidence that previously delivered memory materially affected execution. Use applied only after it influenced an action; use validated only after objective evidence such as passing tests, accepted output, or explicit user confirmation. Never mark task/session completion alone as validation. Does not change promotion or ranking counters.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string' },
        stage: { type: 'string', enum: ['applied', 'validated'] },
        asset_ids: { type: 'array', items: { type: 'string' } },
        outcome: { type: 'string', enum: ['used', 'ignored', 'corrected', 'harmful'] },
        host: { type: 'string' },
        agent_key: { type: 'string' },
        project: { type: 'string' },
        evidence: { type: 'string', description: 'Short evidence class, never prompt or full result text' },
      },
      required: ['trace_id', 'stage', 'asset_ids'],
    },
  },
  {
    name: 'profile_get',
    description: "Read the user's cognitive profile sections (identity, preferences, cognition, competence map) mirrored from the distill pipeline.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_list',
    description: 'List installed MetaMe skills with their descriptions, so any agent can discover available capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string' }, agent_key: { type: 'string' }, project: { type: 'string' },
      },
    },
  },
  {
    name: 'skill_get',
    description: 'Read the full SKILL.md instructions of a named skill.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from skill_list' },
        trace_id: { type: 'string' }, host: { type: 'string' }, agent_key: { type: 'string' }, project: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agent_context',
    description: "Read a MetaMe agent's identity layer (soul.md + memory snapshot) to act on its behalf.",
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'Agent id under ~/.metame/agents/' } },
      required: ['agent_id'],
    },
  },
];

// ── Handlers (pure-ish; deps injectable for tests) ───────────────────────────

function defaultDeps() {
  return {
    memory: () => require('./memory'),
    planRecall: () => require('./core/recall-plan').planRecall,
    assembleRecallContext: () => require('./memory-recall').assembleRecallContext,
    writeFact: () => require('./memory-write').writeFact,
    recordAudit: () => require('./core/recall-audit-db').recordAudit,
    skillsDir: SKILLS_DIR,
    agentsDir: AGENTS_DIR,
    dbPath: DB_PATH,
  };
}

function normalizeLegacyAgentKey(args = {}) {
  const raw = String(args.agent_key || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return raw || null;
}

function resolveMcpAccess(args, deps) {
  const hasAccessProvider = typeof deps.accessContext === 'function';
  let suppliedContext = null;
  if (hasAccessProvider) {
    try { suppliedContext = deps.accessContext(); } catch { suppliedContext = null; }
  }
  const hasTrustedSeam = !!(suppliedContext && isTrustedAccess(suppliedContext));
  return {
    hasTrustedSeam,
    context: resolveAccessContext({
      trustedContext: hasTrustedSeam ? suppliedContext : null,
      request: args,
    }),
    // Existing direct callers predate managed binding injection. Keep their
    // explicit agent selector working, but sanitize it and never use it when
    // a real trusted binding is present.
    legacyAgentKey: hasTrustedSeam ? null : normalizeLegacyAgentKey(args),
  };
}

function readSkillMeta(dir, name) {
  const file = path.join(dir, name, 'SKILL.md');
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const m = head.match(/description:\s*\|?\s*\n?([\s\S]{0,400}?)(?:\n[a-z_-]+:|\n---)/i)
      || head.match(/description:\s*(.+)/i);
    return { name, description: (m ? m[1] : '').replace(/\s+/g, ' ').trim().slice(0, 300) };
  } catch {
    return null;
  }
}

const handlers = {
  async memory_search(args, deps) {
    const startedAt = Date.now();
    const memory = deps.memory();
    const access = resolveMcpAccess(args, deps);
    const project = access.context.project || null;
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const hybrid = await memory.hybridSearchWiki(String(args.query || ''), {
      scopeKeys: scopeKeys(project),
      projectKey: project,
      trackSearch: false,
    });
    const assembled = assembleSearchResults(hybrid, { limit, maxChars: args.max_chars });
    const traceId = `mcp_${crypto.randomUUID()}`;
    for (const item of assembled.results) {
      deps.recordAudit()({
        id: `ca_${crypto.randomUUID()}`,
        phase: 'consume',
        consumer_stage: 'delivered',
        consumer_type: 'mcp',
        trace_id: traceId,
        engine: access.hasTrustedSeam ? access.context.host : (args.host || null),
        agent_key: access.hasTrustedSeam ? access.context.agent_id : (args.agent_key || null),
        project,
        source_refs: [`${item.type}:${item.id}`],
        injected_chars: JSON.stringify(item).length,
        latency_ms: Date.now() - startedAt,
        outcome: 'injected',
      });
    }
    return { trace_id: traceId, ...assembled };
  },

  async memory_get(args, deps) {
    const traceId = String(args.trace_id || '').trim();
    const assetRef = `${args.type}:${args.id}`;
    if (!traceId) return { found: false, error: 'trace_id is required' };
    const access = resolveMcpAccess(args, deps);
    const project = access.context.project || null;
    const memory = deps.memory();
    const asset = memory.getCognitiveAsset(String(args.type || ''), String(args.id || ''), {
      project,
      history: args.history === true,
    });
    if (!asset) return { found: false };
    deps.recordAudit()({
      id: `ca_${crypto.randomUUID()}`,
      phase: 'consume',
      consumer_stage: 'opened',
      consumer_type: 'mcp',
      trace_id: traceId,
      engine: access.hasTrustedSeam ? access.context.host : (args.host || null),
      agent_key: access.hasTrustedSeam ? access.context.agent_id : (args.agent_key || null),
      project,
      source_refs: [assetRef],
      injected_chars: JSON.stringify(asset).length,
      outcome: 'used',
    });
    return { found: true, trace_id: traceId, asset };
  },

  async memory_recall(args, deps) {
    const access = resolveMcpAccess(args, deps);
    const text = String(args.text || '').trim();
    const planned = deps.planRecall()({ text });
    const plan = planned.shouldRecall ? planned : {
      shouldRecall: true,
      reason: 'explicit-mcp',
      anchors: [`query:${text}`],
      modes: ['facts', 'sessions', 'wiki'],
      hintBudget: 2400,
    };
    const ctx = await deps.assembleRecallContext()({
      plan,
      scope: {
        project: access.context.project || null,
        agentKey: access.hasTrustedSeam ? access.context.agent_id : access.legacyAgentKey,
      },
    });
    const traceId = `mcp_${crypto.randomUUID()}`;
    const sourceRefs = Array.isArray(ctx.sources)
      ? [...new Set(ctx.sources.map(toBoundedSourceRef).filter(Boolean))].slice(0, 32)
      : [];
    const context = typeof ctx.text === 'string' ? ctx.text : '';
    if (context.length > 0) {
      // Audit only the bounded delivery metadata.  The prompt and assembled
      // recall text must never enter recall_audit, even when an MCP caller
      // supplied sensitive search terms.
      deps.recordAudit()({
        id: `ca_${crypto.randomUUID()}`,
        phase: 'consume',
        consumer_stage: 'delivered',
        consumer_type: 'mcp',
        trace_id: traceId,
        engine: access.hasTrustedSeam ? access.context.host : (args.host || null),
        agent_key: access.hasTrustedSeam ? access.context.agent_id : (args.agent_key || null),
        project: access.context.project || null,
        source_refs: sourceRefs,
        injected_chars: Math.min(context.length, 12000),
        outcome: 'injected',
      });
    }
    return { recalled: true, trace_id: traceId, reason: plan.reason, context, sources: ctx.sources || [], truncated: !!ctx.truncated };
  },

  async memory_write(args, deps) {
    const access = resolveMcpAccess(args, deps);
    const outcome = deps.writeFact()({
      entity: args.entity,
      relation: args.relation,
      value: args.value,
      confidence: args.confidence || 'medium',
      project: access.context.project || args.project || '*',
      tags: Array.isArray(args.tags) ? args.tags : [],
      sourceType: 'mcp',
    });
    if (!outcome.ok && outcome.errors) return { saved: false, errors: outcome.errors };
    return { saved: outcome.ok, skipped: outcome.result ? outcome.result.skipped : 0 };
  },

  async memory_feedback(args, deps) {
    const access = resolveMcpAccess(args, deps);
    const stage = ['applied', 'validated'].includes(args.stage) ? args.stage : null;
    const traceId = String(args.trace_id || '').trim();
    const assetIds = Array.isArray(args.asset_ids) ? args.asset_ids.map(String).filter(Boolean).slice(0, 20) : [];
    if (!stage || !traceId || assetIds.length === 0) return { recorded: false, error: 'trace_id, valid stage, and asset_ids are required' };
    const allowedOutcomes = new Set(['used', 'ignored', 'corrected', 'harmful']);
    const outcome = allowedOutcomes.has(args.outcome) ? args.outcome : (stage === 'validated' ? 'used' : 'planned');
    deps.recordAudit()({
      id: `ca_${crypto.randomUUID()}`,
      phase: 'consume',
      consumer_stage: stage,
      consumer_type: 'mcp',
      trace_id: traceId,
      engine: access.hasTrustedSeam ? access.context.host : (args.host || null),
      agent_key: access.hasTrustedSeam ? access.context.agent_id : (args.agent_key || null),
      project: access.context.project || null,
      source_refs: assetIds,
      outcome,
      evidence_class: args.evidence ? String(args.evidence).slice(0, 80) : null,
    });
    return { recorded: true, trace_id: traceId, stage };
  },

  async profile_get(args, deps) {
    const { DatabaseSync } = require('node:sqlite');
    let db;
    try {
      db = new DatabaseSync(deps.dbPath, { readOnly: true });
      const rows = db.prepare(
        `SELECT title, content FROM memory_items WHERE kind = 'profile' AND state = 'active' ORDER BY title`
      ).all();
      if (rows.length === 0) return { sections: [], note: 'profile mirror empty — distill has not run since mirroring was enabled' };
      return { sections: rows.map(r => ({ section: r.title, content: r.content })) };
    } finally {
      try { if (db) db.close(); } catch { /* ignore */ }
    }
  },

  async skill_list(args, deps) {
    const access = resolveMcpAccess(args, deps);
    let entries = [];
    try {
      entries = fs.readdirSync(deps.skillsDir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map(e => readSkillMeta(deps.skillsDir, e.name))
        .filter(Boolean);
    } catch { /* skills dir missing */ }
    const traceId = `mcp_${crypto.randomUUID()}`;
    for (const entry of entries) {
      deps.recordAudit()({
        id: `ca_${crypto.randomUUID()}`, phase: 'consume', consumer_stage: 'delivered', consumer_type: 'mcp',
        trace_id: traceId,
        engine: access.hasTrustedSeam ? access.context.host : (args.host || null),
        agent_key: access.hasTrustedSeam ? access.context.agent_id : (args.agent_key || null),
        project: access.context.project || null, source_refs: [`skill:${entry.name}`],
        injected_chars: JSON.stringify(entry).length, outcome: 'injected',
      });
    }
    return { trace_id: traceId, skills: entries };
  },

  async skill_get(args, deps) {
    const name = String(args.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) return { error: 'invalid skill name' };
    try {
      const content = fs.readFileSync(path.join(deps.skillsDir, name, 'SKILL.md'), 'utf8');
      const access = resolveMcpAccess(args, deps);
      const traceId = String(args.trace_id || `mcp_${crypto.randomUUID()}`);
      deps.recordAudit()({
        id: `ca_${crypto.randomUUID()}`, phase: 'consume', consumer_stage: 'opened', consumer_type: 'mcp',
        trace_id: traceId,
        engine: access.hasTrustedSeam ? access.context.host : (args.host || null),
        agent_key: access.hasTrustedSeam ? access.context.agent_id : (args.agent_key || null),
        project: access.context.project || null, source_refs: [`skill:${name}`], injected_chars: content.length, outcome: 'used',
      });
      return { name, trace_id: traceId, content };
    } catch {
      return { error: `skill not found: ${name}` };
    }
  },

  async agent_context(args, deps) {
    const id = String(args.agent_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) return { error: 'invalid agent id' };
    // Keep the old injectable characterization seam, but the executable MCP
    // boundary must prove the requested agent is the managed principal.
    const access = resolveMcpAccess(args, deps);
    if (access.hasTrustedSeam) {
      if (!access.context.agent_id || access.context.agent_id !== id) {
        return { error: 'agent_context_unauthorized' };
      }
    }
    const base = path.join(deps.agentsDir, id);
    const read = (f) => { try { return fs.readFileSync(path.join(base, f), 'utf8'); } catch { return ''; } };
    const soul = read('soul.md');
    const snapshot = read('memory-snapshot.md');
    if (!soul && !snapshot) return { error: `agent not found: ${id}` };
    return { agent_id: id, soul, memory_snapshot: snapshot };
  },
};

async function callTool(name, args, deps = defaultDeps()) {
  const handler = handlers[name];
  if (!handler) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  return handler(args || {}, deps);
}

// ── Transport: newline-delimited JSON-RPC over stdio ─────────────────────────

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params && params.name, params && params.arguments);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      if (err && err.code === -32602) return rpcError(id, -32602, err.message);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true });
    }
  }
  if (id !== undefined && id !== null) return rpcError(id, -32601, `method not found: ${method}`);
  return null;
}

// Retained as a characterization seam for existing unit tests and for callers
// that import handleMessage directly. The executable entrypoint below uses
// the official SDK transport instead.
function startLegacyStdioServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try {
        const reply = await handleMessage(msg);
        if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
      } catch (err) {
        if (msg.id !== undefined) process.stdout.write(JSON.stringify(rpcError(msg.id, -32603, err.message)) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

async function startStdioServer() {
  let sdk;
  try {
    // npm installs resolve the maintained SDK from package dependencies.
    // Claude's GitHub plugin is intentionally a no-npm distribution, so it
    // carries the auditable SDK-only bundle as a sibling fallback.
    sdk = await import('./metame-mcp-server-sdk.mjs');
  } catch (error) {
    const message = error && error.message ? error.message : String(error || '');
    const missingSdk = error && error.code === 'ERR_MODULE_NOT_FOUND'
      && /@modelcontextprotocol\/(?:server|core)|(?:^|[\s'])zod(?:[\/'"]|$)/.test(message);
    if (!missingSdk) throw error;
    sdk = await import('./metame-mcp-server-sdk.bundle.mjs');
  }
  return sdk.startStdioServer();
}

if (require.main === module) {
  startStdioServer().catch(error => {
    process.stderr.write(`[metame-mcp] ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  TOOLS,
  handlers,
  callTool,
  handleMessage,
  startStdioServer,
  _private: { readSkillMeta, defaultDeps, startLegacyStdioServer },
};

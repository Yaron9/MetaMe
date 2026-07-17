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
 * Hand-written newline-delimited JSON-RPC (initialize / tools/list /
 * tools/call) — tools-only surface, no SDK dependency (repo discipline).
 * Every tool is a thin wrapper over an existing module; no memory logic
 * lives here. Writes go through memory-write's validation + candidate
 * pipeline and are tagged source `mcp` for auditability.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const AGENTS_DIR = path.join(HOME, '.metame', 'agents');
const DB_PATH = path.join(HOME, '.metame', 'memory.db');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'metame', version: '1.0.0' };

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search MetaMe long-term memory (facts + knowledge wiki) with hybrid FTS/vector ranking. Returns matching items with titles and content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords, file names, topics)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
        project: { type: 'string', description: 'Optional project filter' },
      },
      required: ['query'],
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
    name: 'profile_get',
    description: "Read the user's cognitive profile sections (identity, preferences, cognition, competence map) mirrored from the distill pipeline.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_list',
    description: 'List installed MetaMe skills with their descriptions, so any agent can discover available capabilities.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'skill_get',
    description: 'Read the full SKILL.md instructions of a named skill.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name from skill_list' } },
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
    skillsDir: SKILLS_DIR,
    agentsDir: AGENTS_DIR,
    dbPath: DB_PATH,
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
    const memory = deps.memory();
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const facts = await memory.searchFactsAsync(String(args.query || ''), {
      limit,
      project: args.project || null,
      trackSearch: false,
    });
    // searchFacts returns the legacy fact shape: entity/relation/value.
    return {
      results: (facts || []).map(f => ({
        id: f.id,
        entity: f.entity,
        relation: f.relation,
        value: f.value,
        confidence: f.confidence,
        project: f.project,
        tags: f.tags,
      })),
    };
  },

  async memory_recall(args, deps) {
    const plan = deps.planRecall()({ text: String(args.text || '') });
    if (!plan.shouldRecall) return { recalled: false, reason: 'no trigger — message does not reference past context' };
    const ctx = await deps.assembleRecallContext()({
      plan,
      scope: { project: args.project || null, agentKey: args.agent_key || null },
    });
    return { recalled: true, reason: plan.reason, context: ctx.text || '', sources: ctx.sources || [], truncated: !!ctx.truncated };
  },

  async memory_write(args, deps) {
    const outcome = deps.writeFact()({
      entity: args.entity,
      relation: args.relation,
      value: args.value,
      confidence: args.confidence || 'medium',
      project: args.project || '*',
      tags: Array.isArray(args.tags) ? args.tags : [],
      sourceType: 'mcp',
    });
    if (!outcome.ok && outcome.errors) return { saved: false, errors: outcome.errors };
    return { saved: outcome.ok, skipped: outcome.result ? outcome.result.skipped : 0 };
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
    let entries = [];
    try {
      entries = fs.readdirSync(deps.skillsDir, { withFileTypes: true })
        .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .map(e => readSkillMeta(deps.skillsDir, e.name))
        .filter(Boolean);
    } catch { /* skills dir missing */ }
    return { skills: entries };
  },

  async skill_get(args, deps) {
    const name = String(args.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!name) return { error: 'invalid skill name' };
    try {
      return { name, content: fs.readFileSync(path.join(deps.skillsDir, name, 'SKILL.md'), 'utf8') };
    } catch {
      return { error: `skill not found: ${name}` };
    }
  },

  async agent_context(args, deps) {
    const id = String(args.agent_id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) return { error: 'invalid agent id' };
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

function startStdioServer() {
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

if (require.main === module) startStdioServer();

module.exports = { TOOLS, handlers, callTool, handleMessage, _private: { readSkillMeta, defaultDeps } };

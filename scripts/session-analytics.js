#!/usr/bin/env node

/**
 * MetaMe Session Analytics — Local Skeleton Extraction
 *
 * Parses Claude Code session JSONL transcripts to extract
 * behavioral structure (tool usage, duration, git activity).
 * Pure local processing — zero API cost.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { deriveProjectInfo } = require('./utils');

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects');
const STATE_FILE = path.join(HOME, '.metame', 'analytics_state.json');
const STATE_DB = path.join(HOME, '.metame', 'analytics_state.db');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MIN_FILE_SIZE = 1024;               // 1KB
let _stateDb = null;
let _stmtIsProcessed = null;
let _stmtMarkProcessed = null;

/**
 * Initialize analytics state DB.
 */
function getStateDb() {
  if (_stateDb) return _stateDb;
  const dir = path.dirname(STATE_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  _stateDb = new DatabaseSync(STATE_DB);
  _stateDb.exec('PRAGMA journal_mode = WAL');
  _stateDb.exec('PRAGMA busy_timeout = 3000');
  _stateDb.exec(`
    CREATE TABLE IF NOT EXISTS processed_sessions (
      kind         TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, session_id)
    )
  `);
  _stateDb.exec('CREATE INDEX IF NOT EXISTS idx_processed_kind_ts ON processed_sessions(kind, processed_at)');
  _stateDb.exec('CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)');
  migrateLegacyStateOnce(_stateDb);
  return _stateDb;
}

/**
 * One-time migration from legacy JSON state file.
 */
function migrateLegacyStateOnce(db) {
  try {
    const migrated = db.prepare("SELECT value FROM state_meta WHERE key = 'legacy_json_migrated'").get();
    if (migrated && migrated.value === '1') return;

    if (fs.existsSync(STATE_FILE)) {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { raw = null; }
      if (raw && typeof raw === 'object') {
        const insert = db.prepare(`
          INSERT INTO processed_sessions (kind, session_id, processed_at)
          VALUES (?, ?, ?)
          ON CONFLICT(kind, session_id) DO UPDATE SET processed_at = excluded.processed_at
        `);
        const tx = db.transaction(() => {
          for (const [sid, ts] of Object.entries(raw.analyzed || {})) {
            insert.run('analyzed', sid, Number(ts) || Date.now());
          }
          for (const [sid, ts] of Object.entries(raw.facts_analyzed || {})) {
            insert.run('facts_analyzed', sid, Number(ts) || Date.now());
          }
        });
        tx();
      }
    }

    db.prepare("INSERT OR REPLACE INTO state_meta (key, value) VALUES ('legacy_json_migrated', '1')").run();
  } catch {
    // non-fatal
  }
}

function isProcessed(kind, sessionId) {
  if (!kind || !sessionId) return false;
  const db = getStateDb();
  if (!_stmtIsProcessed) {
    _stmtIsProcessed = db.prepare(
      'SELECT 1 AS ok FROM processed_sessions WHERE kind = ? AND session_id = ? LIMIT 1'
    );
  }
  const row = _stmtIsProcessed.get(kind, sessionId);
  return !!(row && row.ok === 1);
}

/**
 * Mark a session as processed in DB.
 */
function markProcessed(kind, sessionId) {
  if (!sessionId) return;
  const db = getStateDb();
  if (!_stmtMarkProcessed) {
    _stmtMarkProcessed = db.prepare(`
      INSERT INTO processed_sessions (kind, session_id, processed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(kind, session_id) DO UPDATE SET processed_at = excluded.processed_at
    `);
  }
  _stmtMarkProcessed.run(kind, sessionId, Date.now());
}

/**
 * Find the latest unanalyzed session JSONL across all projects.
 * Returns { path, session_id, mtime } or null.
 */
function findLatestUnanalyzedSession() {
  let best = null;

  try {
    const projectDirs = fs.readdirSync(PROJECTS_ROOT);
    for (const dir of projectDirs) {
      const fullDir = path.join(PROJECTS_ROOT, dir);
      let stat;
      try { stat = fs.statSync(fullDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      let files;
      try { files = fs.readdirSync(fullDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (isProcessed('analyzed', sessionId)) continue;

        const fullPath = path.join(fullDir, file);
        let fstat;
        try { fstat = fs.statSync(fullPath); } catch { continue; }

        // Skip files that are too large or too small
        if (fstat.size > MAX_FILE_SIZE || fstat.size < MIN_FILE_SIZE) continue;

        if (!best || fstat.mtimeMs > best.mtime) {
          best = { path: fullPath, session_id: sessionId, mtime: fstat.mtimeMs };
        }
      }
    }
  } catch {
    // Projects root doesn't exist yet
    return null;
  }

  return best;
}

/**
 * Extract a behavioral skeleton from a session JSONL file.
 * Only parses structural data — no content analysis of tool results.
 */
function extractSkeleton(jsonlPath) {
  const content = fs.readFileSync(jsonlPath, 'utf8');
  const lines = content.split('\n');

  const skeleton = {
    session_id: path.basename(jsonlPath, '.jsonl'),
    user_snippets: [],
    tool_counts: {},
    total_tool_calls: 0,
    models: new Set(),
    git_committed: false,
    first_ts: null,
    last_ts: null,
    message_count: 0,
    duration_min: 0,
    project: null,
    project_id: null,
    project_path: null,
    branch: null,
    file_dirs: new Set(),
    intent: null,
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    // Fast pre-filter: only parse lines that look like user or assistant messages
    if (!line.includes('"type":"user"') &&
        !line.includes('"type":"assistant"') &&
        !line.includes('"type": "user"') &&
        !line.includes('"type": "assistant"')) {
      continue;
    }

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    const type = entry.type;
    const ts = entry.timestamp;

    // Track timestamps for duration
    if (ts) {
      if (!skeleton.first_ts || ts < skeleton.first_ts) skeleton.first_ts = ts;
      if (!skeleton.last_ts || ts > skeleton.last_ts) skeleton.last_ts = ts;
    }

    if (type === 'user') {
      // Extract project and branch from first occurrence
      if (!skeleton.project && entry.cwd) {
        const info = deriveProjectInfo(entry.cwd);
        skeleton.project = info.project;
        skeleton.project_id = info.project_id;
        skeleton.project_path = info.project_path;
      }
      if (!skeleton.branch && entry.gitBranch) {
        skeleton.branch = entry.gitBranch;
      }

      const msg = entry.message;
      if (!msg || !msg.content) continue;

      const content = msg.content;
      // Handle both string and array content
      let userText = '';
      if (typeof content === 'string') {
        userText = content;
        skeleton.user_snippets.push(content.slice(0, 100));
        skeleton.message_count++;
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'text' && item.text) {
            userText = item.text;
            skeleton.user_snippets.push(item.text.slice(0, 100));
            skeleton.message_count++;
            break; // One snippet per user message
          }
        }
      }

      // Extract intent from first substantial user message
      if (!skeleton.intent && userText.length >= 15 && !userText.startsWith('[Request interrupted')) {
        skeleton.intent = userText.slice(0, 80);
      }
    } else if (type === 'assistant') {
      const msg = entry.message;
      if (!msg) continue;

      // Track model
      if (msg.model) skeleton.models.add(msg.model);

      // Count tool calls
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'tool_use') {
            const name = item.name || 'unknown';
            skeleton.tool_counts[name] = (skeleton.tool_counts[name] || 0) + 1;
            skeleton.total_tool_calls++;

            // Extract file directories from Read/Edit/Write operations
            if ((name === 'Read' || name === 'Edit' || name === 'Write') &&
                item.input && typeof item.input.file_path === 'string') {
              const dirPath = path.dirname(item.input.file_path);
              const segments = dirPath.split(path.sep).filter(Boolean);
              const shortDir = segments.slice(-2).join('/');
              if (shortDir) skeleton.file_dirs.add(shortDir);
            }

            // Detect git commits from Bash tool calls
            if (name === 'Bash' && item.input && typeof item.input.command === 'string') {
              const cmd = item.input.command;
              if (cmd.includes('git commit') || cmd.includes('git push')) {
                skeleton.git_committed = true;
              }
            }
          }
        }
      }
    }
  }

  // Calculate duration
  if (skeleton.first_ts && skeleton.last_ts) {
    const start = new Date(skeleton.first_ts).getTime();
    const end = new Date(skeleton.last_ts).getTime();
    skeleton.duration_min = Math.round((end - start) / 60000);
  }

  // Convert Sets to arrays for serialization
  skeleton.models = [...skeleton.models];
  skeleton.file_dirs = [...skeleton.file_dirs].slice(0, 5);

  // Cap user snippets at 10
  if (skeleton.user_snippets.length > 10) {
    skeleton.user_snippets = skeleton.user_snippets.slice(0, 10);
  }

  return skeleton;
}

/**
 * Extract compact evidence from a session JSONL for memory extraction.
 * Returns { user_messages, tool_traces, key_results, file_anchors }.
 */
function extractEvidence(jsonlPath, budget = 3000) {
  const content = fs.readFileSync(jsonlPath, 'utf8');
  const lines = content.split('\n');

  const totalBudget = Math.max(600, budget);
  const userBudget = Math.floor(totalBudget / 3);
  const toolBudget = Math.floor(totalBudget / 3);
  const resultBudget = totalBudget - userBudget - toolBudget;

  const evidence = {
    user_messages: [],
    tool_traces: [],
    key_results: [],
    file_anchors: [],
  };

  const seen = {
    user: new Set(),
    tool: new Set(),
    result: new Set(),
    file: new Set(),
  };
  const used = { user: 0, tool: 0, result: 0 };

  const addWithBudget = (bucket, key, text, maxChars) => {
    if (!text || !text.trim()) return;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || seen[key].has(normalized)) return;
    const room = maxChars - used[key];
    if (room <= 0) return;
    const clipped = normalized.slice(0, room);
    if (clipped.length < 12) return;
    bucket.push(clipped);
    seen[key].add(normalized);
    used[key] += clipped.length;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.includes('"type"')) continue;

    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    // User raw messages (exclude tool_result wrappers)
    if (entry.type === 'user' && entry.message && entry.message.content) {
      const msg = entry.message.content;
      if (typeof msg === 'string') {
        addWithBudget(evidence.user_messages, 'user', msg, userBudget);
      } else if (Array.isArray(msg)) {
        for (const item of msg) {
          if (item && item.type === 'text' && item.text) {
            addWithBudget(evidence.user_messages, 'user', item.text, userBudget);
          } else if (item && item.type === 'tool_result' && item.is_error) {
            const toolText = typeof item.content === 'string'
              ? item.content
              : Array.isArray(item.content)
                ? item.content.map(c => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join(' ')
                : '';
            addWithBudget(evidence.key_results, 'result', `tool_result error: ${toolText.slice(0, 120)}`, resultBudget);
          }
        }
      }
    }

    if (entry.type === 'assistant' && entry.message && Array.isArray(entry.message.content)) {
      for (const item of entry.message.content) {
        if (!item || item.type !== 'tool_use') continue;
        const name = item.name || 'unknown';
        const input = item.input || {};

        if ((name === 'Write' || name === 'Edit') && typeof input.file_path === 'string') {
          const base = path.basename(input.file_path);
          const trace = `${name} ${base}`;
          addWithBudget(evidence.tool_traces, 'tool', trace, toolBudget);
          if (base && !seen.file.has(base)) {
            evidence.file_anchors.push(base);
            seen.file.add(base);
          }
        } else if (name === 'Bash' && typeof input.command === 'string') {
          const cmd = input.command.replace(/\s+/g, ' ').trim();
          const trace = `Bash ${cmd.slice(0, 120)}`;
          addWithBudget(evidence.tool_traces, 'tool', trace, toolBudget);
        }
      }
    }

    // tool_result can appear as standalone event in some transcripts
    if (entry.type === 'tool_result') {
      const result = entry.message || {};
      const isError = !!result.is_error;
      const snippet = typeof result.content === 'string'
        ? result.content
        : Array.isArray(result.content)
          ? result.content.map(c => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join(' ')
          : '';
      if (isError) {
        addWithBudget(evidence.key_results, 'result', `tool_result error: ${snippet.slice(0, 120)}`, resultBudget);
      }
    }
  }

  // Tight caps keep payload small and predictable
  evidence.user_messages = evidence.user_messages.slice(0, 8);
  evidence.tool_traces = evidence.tool_traces.slice(0, 12);
  evidence.key_results = evidence.key_results.slice(0, 6);
  evidence.file_anchors = evidence.file_anchors.slice(0, 12);

  return evidence;
}

/**
 * Format skeleton as a compact one-liner for injection into the distill prompt.
 * Target: ~60 tokens.
 */
function formatForPrompt(skeleton) {
  if (!skeleton) return '';

  const toolSummary = Object.entries(skeleton.tool_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');

  const parts = [];
  if (skeleton.project) {
    const projLabel = skeleton.branch ? `${skeleton.project}@${skeleton.branch}` : skeleton.project;
    parts.push(`Proj=${projLabel}`);
  }
  if (skeleton.duration_min > 0) parts.push(`Duration: ${skeleton.duration_min}min`);
  parts.push(`Messages: ${skeleton.message_count}`);
  if (skeleton.total_tool_calls > 0) parts.push(`Tools: ${skeleton.total_tool_calls} (${toolSummary})`);
  if (skeleton.git_committed) parts.push('Git: committed');
  if (skeleton.models.length > 0) {
    const shortModels = skeleton.models.map(m => {
      if (m.includes('opus')) return 'opus';
      if (m.includes('sonnet')) return 'sonnet';
      if (m.includes('haiku')) return 'haiku';
      return m.split('-')[0];
    });
    parts.push(`Model: ${[...new Set(shortModels)].join(',')}`);
  }

  return parts.join(' | ');
}

/**
 * Find all unanalyzed sessions across all projects, sorted by mtime descending.
 * Returns array of { path, session_id, mtime }. Capped at `limit`.
 */
function findAllUnanalyzedSessions(limit = 30) {
  const results = [];

  try {
    const projectDirs = fs.readdirSync(PROJECTS_ROOT);
    for (const dir of projectDirs) {
      const fullDir = path.join(PROJECTS_ROOT, dir);
      let stat;
      try { stat = fs.statSync(fullDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      let files;
      try { files = fs.readdirSync(fullDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (isProcessed('analyzed', sessionId)) continue;

        const fullPath = path.join(fullDir, file);
        let fstat;
        try { fstat = fs.statSync(fullPath); } catch { continue; }

        if (fstat.size > MAX_FILE_SIZE || fstat.size < MIN_FILE_SIZE) continue;

        results.push({ path: fullPath, session_id: sessionId, mtime: fstat.mtimeMs });
      }
    }
  } catch {
    return [];
  }

  // Sort by mtime descending (newest first), take `limit`
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/**
 * Mark a session as analyzed (cognitive distill / pattern detection).
 */
function markAnalyzed(sessionId) {
  markProcessed('analyzed', sessionId);
}

/**
 * Find all sessions not yet processed by memory-extract (facts extraction).
 * Uses a separate `facts_analyzed` key so distill and memory-extract don't interfere.
 */
function findAllUnextractedSessions(limit = 30) {
  const results = [];

  try {
    const projectDirs = fs.readdirSync(PROJECTS_ROOT);
    for (const dir of projectDirs) {
      const fullDir = path.join(PROJECTS_ROOT, dir);
      let stat;
      try { stat = fs.statSync(fullDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      let files;
      try { files = fs.readdirSync(fullDir); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionId = file.replace('.jsonl', '');
        if (isProcessed('facts_analyzed', sessionId)) continue;

        const fullPath = path.join(fullDir, file);
        let fstat;
        try { fstat = fs.statSync(fullPath); } catch { continue; }

        if (fstat.size > MAX_FILE_SIZE || fstat.size < MIN_FILE_SIZE) continue;

        results.push({ path: fullPath, session_id: sessionId, mtime: fstat.mtimeMs });
      }
    }
  } catch {
    return [];
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/**
 * Mark a session as facts-extracted (used by memory-extract, independent of markAnalyzed).
 */
function markFactsExtracted(sessionId) {
  markProcessed('facts_analyzed', sessionId);
}

/**
 * Find a session jsonl by its session id.
 * Returns { path, session_id, mtime } or null.
 */
function findSessionById(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;

  try {
    const projectDirs = fs.readdirSync(PROJECTS_ROOT);
    for (const dir of projectDirs) {
      const fullDir = path.join(PROJECTS_ROOT, dir);
      let stat;
      try { stat = fs.statSync(fullDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const fullPath = path.join(fullDir, `${sid}.jsonl`);
      let fstat;
      try { fstat = fs.statSync(fullPath); } catch { continue; }
      if (fstat.size > MAX_FILE_SIZE || fstat.size < MIN_FILE_SIZE) continue;
      return { path: fullPath, session_id: sid, mtime: fstat.mtimeMs };
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Read declared goals from the user's profile.
 * Returns a compact string like "DECLARED_GOALS: focus1 | focus2" (~11 tokens).
 */
function formatGoalContext(profilePath) {
  try {
    const yaml = require('js-yaml');
    const profile = yaml.load(fs.readFileSync(profilePath, 'utf8')) || {};
    const goals = [];
    if (profile.status && profile.status.focus) goals.push(profile.status.focus);
    if (profile.context && profile.context.focus && profile.context.focus !== (profile.status && profile.status.focus)) {
      goals.push(profile.context.focus);
    }
    if (goals.length === 0) return '';
    return `DECLARED_GOALS: ${goals.join(' | ')}`;
  } catch { return ''; }
}

/**
 * Extract pivot points (key moments) from a session JSONL.
 * Only called for long sessions (>20min + >15 tools).
 * Returns array of pivot descriptions (max 3).
 */
function extractPivotPoints(jsonlPath) {
  const content = fs.readFileSync(jsonlPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  const pivots = [];
  let lastUserIntent = null;

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const type = entry.type;

      // Track user direction changes
      if (type === 'user') {
        const msg = entry.message;
        if (!msg || !msg.content) continue;

        const content = typeof msg.content === 'string' ? msg.content :
          (Array.isArray(msg.content) ? msg.content.find(c => c.type === 'text')?.text : null);

        if (!content || content.length < 20) continue;

        // Detect intent shifts
        const keywords = ['改成', '换成', '不对', '重新', '算了', '还是', '改主意', 'change to', 'switch to', 'actually', 'wait', 'no', 'instead'];
        const hasShift = keywords.some(k => content.toLowerCase().includes(k.toLowerCase()));

        if (hasShift && lastUserIntent && pivots.length < 3) {
          pivots.push(`Shift: "${lastUserIntent.slice(0, 40)}" → "${content.slice(0, 40)}"`);
        }

        lastUserIntent = content.slice(0, 80);
      }

      // Track tool failures (simplified — only catch explicit error mentions)
      if (type === 'tool_result' && pivots.length < 3) {
        const result = entry.message;
        if (result && result.is_error) {
          const toolName = entry.message.tool_use_id || 'Tool';
          pivots.push(`${toolName} error`);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return pivots;
}

/**
 * Generate a lightweight summary for long sessions.
 * Only called for sessions with duration > 20min AND tool_calls > 15.
 * Returns { intent, pivots, outcome } or null.
 */
function summarizeSession(skeleton, jsonlPath) {
  // Trigger condition: long + complex session
  if (skeleton.duration_min < 20 || skeleton.total_tool_calls < 15) {
    return null;
  }

  const pivots = extractPivotPoints(jsonlPath);

  return {
    intent: skeleton.intent || 'Unknown',
    pivots: pivots.slice(0, 3),
    outcome: skeleton.git_committed ? 'committed' : 'exploratory'
  };
}

module.exports = {
  findLatestUnanalyzedSession,
  findSessionById,
  findAllUnanalyzedSessions,
  findAllUnextractedSessions,
  extractSkeleton,
  extractEvidence,
  formatForPrompt,
  formatGoalContext,
  summarizeSession,
  markAnalyzed,
  markFactsExtracted,
};

// Direct execution for testing
if (require.main === module) {
  console.log('🔍 Session Analytics — Testing\n');

  const latest = findLatestUnanalyzedSession();
  if (!latest) {
    console.log('No unanalyzed sessions found.');
    process.exit(0);
  }

  console.log(`Session: ${latest.session_id}`);
  console.log(`Path: ${latest.path}`);
  console.log(`Modified: ${new Date(latest.mtime).toISOString()}\n`);

  const skeleton = extractSkeleton(latest.path);
  console.log('Skeleton:', JSON.stringify(skeleton, null, 2));
  console.log('\nPrompt format:', formatForPrompt(skeleton));

  const goalCtx = formatGoalContext(path.join(HOME, '.claude_profile.yaml'));
  if (goalCtx) console.log('Goal context:', goalCtx);
}

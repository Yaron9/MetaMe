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

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, '.claude', 'projects');
const STATE_FILE = path.join(HOME, '.metame', 'analytics_state.json');
const MAX_STATE_ENTRIES = 200;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MIN_FILE_SIZE = 1024;               // 1KB

/**
 * Load analytics state (set of already-analyzed session IDs).
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* corrupt state — start fresh */ }
  return { analyzed: {} };
}

/**
 * Save analytics state.
 */
function saveState(state) {
  // Cap entries
  const keys = Object.keys(state.analyzed);
  if (keys.length > MAX_STATE_ENTRIES) {
    const sorted = keys.sort((a, b) => (state.analyzed[a] || 0) - (state.analyzed[b] || 0));
    const toRemove = sorted.slice(0, keys.length - MAX_STATE_ENTRIES);
    for (const k of toRemove) delete state.analyzed[k];
  }
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Find the latest unanalyzed session JSONL across all projects.
 * Returns { path, session_id, mtime } or null.
 */
function findLatestUnanalyzedSession() {
  const state = loadState();
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
        if (state.analyzed[sessionId]) continue;

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
        skeleton.project = path.basename(entry.cwd);
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
  const state = loadState();
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
        if (state.analyzed[sessionId]) continue;

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
 * Mark a session as analyzed.
 */
function markAnalyzed(sessionId) {
  const state = loadState();
  state.analyzed[sessionId] = Date.now();
  saveState(state);
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
  findAllUnanalyzedSessions,
  extractSkeleton,
  formatForPrompt,
  formatGoalContext,
  summarizeSession,
  markAnalyzed,
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

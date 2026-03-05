#!/usr/bin/env node

/**
 * MetaMe Stop Hook — Session Event Logger + Tool Failure Capture
 *
 * Runs as a Claude Code "Stop" hook.
 * On each turn end:
 *   1. Appends a lightweight session event to session_events.jsonl
 *   2. Reads the tail of the transcript file to extract tool failures (is_error: true)
 *      and appends them to skill_signals.jsonl
 *
 * Performance target: < 50ms total. Only reads last TAIL_BYTES of transcript.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const METAME_DIR = path.join(os.homedir(), '.metame');
const SESSION_EVENTS = path.join(METAME_DIR, 'session_events.jsonl');
const SKILL_SIGNALS = path.join(METAME_DIR, 'skill_signals.jsonl');

// Only read the last N bytes of the transcript to stay under 50ms.
// 20KB covers ~10-20 conversation turns — enough to capture recent failures.
const TAIL_BYTES = 20 * 1024;

// Cap signal file sizes to prevent unbounded growth.
const MAX_SESSION_EVENTS_LINES = 2000;
const MAX_SKILL_SIGNALS_LINES = 500;

// Deduplicate: remember tool_use_ids we already captured (within this invocation).
// Cross-invocation dedup uses the session_events timestamp as a watermark.
const capturedIds = new Set();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const now = new Date().toISOString();

    fs.mkdirSync(METAME_DIR, { recursive: true });

    // ── 1. Session event (lightweight metadata) ──
    const sessionEntry = {
      ts: now,
      session_id: data.session_id || null,
      cwd: data.cwd || null,
      hint: (data.last_assistant_message || '').slice(0, 200),
    };
    appendWithCap(SESSION_EVENTS, sessionEntry, MAX_SESSION_EVENTS_LINES);

    // ── 2. Tool failure extraction from transcript tail ──
    const transcriptPath = data.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      process.exit(0);
    }

    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) {
      process.exit(0);
    }

    const readSize = Math.min(stat.size, TAIL_BYTES);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const tail = buf.toString('utf8');
    // The first line may be truncated (we read from mid-file), skip it.
    const lines = tail.split('\n');
    if (lines.length > 1) {
      lines.shift();
    }

    // Load last watermark to avoid re-capturing errors from previous turns.
    const watermark = loadWatermark(data.session_id);

    const newSignals = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message;
        if (!msg || !Array.isArray(msg.content)) continue;

        for (const block of msg.content) {
          if (
            block.type === 'tool_result' &&
            block.is_error === true &&
            block.tool_use_id &&
            !capturedIds.has(block.tool_use_id)
          ) {
            capturedIds.add(block.tool_use_id);

            // Find the corresponding tool_use to get the tool name.
            // We do a best-effort lookup within the same tail window.
            const toolName = findToolName(lines, block.tool_use_id);

            const errorContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('\n')
                : JSON.stringify(block.content);

            const signal = {
              ts: now,
              type: 'tool_failure',
              tool: toolName,
              tool_use_id: block.tool_use_id,
              error: errorContent.slice(0, 500),
              session_id: data.session_id || null,
              cwd: data.cwd || null,
            };
            newSignals.push(signal);
          }
        }
      } catch {
        // Skip malformed lines (expected for the first truncated line).
      }
    }

    // Deduplicate against watermark: only write signals with tool_use_ids not seen before.
    const fresh = watermark
      ? newSignals.filter(s => !watermark.has(s.tool_use_id))
      : newSignals;

    for (const signal of fresh) {
      appendWithCap(SKILL_SIGNALS, signal, MAX_SKILL_SIGNALS_LINES);
    }

    // Save watermark: all tool_use_ids we've now captured for this session.
    if (fresh.length > 0) {
      saveWatermark(data.session_id, capturedIds);
    }

  } catch {
    // Never block the user's workflow.
  }
  process.exit(0);
});

/**
 * Append a JSON entry to a file, capping total lines.
 * Uses simple append for speed; cap check is amortized (every 100 writes).
 */
function appendWithCap(filePath, entry, maxLines) {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line);

  // Amortized cap: only check line count occasionally.
  try {
    const stat = fs.statSync(filePath);
    // Rough heuristic: average line ~200 bytes. Only trim if file is suspiciously large.
    if (stat.size > maxLines * 250) {
      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n').filter(Boolean);
      if (allLines.length > maxLines) {
        const trimmed = allLines.slice(-maxLines);
        fs.writeFileSync(filePath, trimmed.join('\n') + '\n');
      }
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Find the tool name for a given tool_use_id by scanning the tail lines.
 */
function findToolName(lines, toolUseId) {
  for (const line of lines) {
    if (!line.includes(toolUseId)) continue;
    try {
      const entry = JSON.parse(line);
      const msg = entry.message;
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id === toolUseId) {
          return block.name || 'unknown';
        }
      }
    } catch {
      // Skip.
    }
  }
  return 'unknown';
}

/**
 * Load watermark (set of captured tool_use_ids) for a session.
 * Stored as a simple JSON file per session to avoid cross-turn duplicates.
 */
function loadWatermark(sessionId) {
  if (!sessionId) return null;
  const wmPath = path.join(METAME_DIR, '.hook_watermarks', `${sessionId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(wmPath, 'utf8'));
    return new Set(data.ids || []);
  } catch {
    return null;
  }
}

function saveWatermark(sessionId, ids) {
  if (!sessionId) return;
  const wmDir = path.join(METAME_DIR, '.hook_watermarks');
  fs.mkdirSync(wmDir, { recursive: true });
  const wmPath = path.join(wmDir, `${sessionId}.json`);

  // Merge with existing watermark.
  let existing = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(wmPath, 'utf8'));
    existing = new Set(data.ids || []);
  } catch {
    // New watermark.
  }

  for (const id of ids) {
    existing.add(id);
  }

  // Cap watermark size (keep last 200 IDs).
  const allIds = [...existing];
  const capped = allIds.length > 200 ? allIds.slice(-200) : allIds;

  fs.writeFileSync(wmPath, JSON.stringify({ ids: capped, updated: new Date().toISOString() }));
}

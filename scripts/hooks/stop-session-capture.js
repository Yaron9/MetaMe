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
    try {
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    } finally {
      fs.closeSync(fd);
    }

    const tail = buf.toString('utf8');
    // The first line may be truncated (we read from mid-file), skip it.
    const lines = tail.split('\n');
    if (lines.length > 1) {
      lines.shift();
    }

    // Single-pass: build tool_use_id → tool_name map + collect error signals.
    const toolNameMap = new Map();
    const newSignals = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message;
        if (!msg || !Array.isArray(msg.content)) continue;

        for (const block of msg.content) {
          // Index tool_use entries for name lookup.
          if (block.type === 'tool_use' && block.id) {
            toolNameMap.set(block.id, block.name || 'unknown');
          }
          // Collect tool failures.
          if (
            block.type === 'tool_result' &&
            block.is_error === true &&
            block.tool_use_id &&
            !capturedIds.has(block.tool_use_id)
          ) {
            capturedIds.add(block.tool_use_id);

            const errorContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(c => (typeof c === 'string' ? c : c.text || '')).join('\n')
                : JSON.stringify(block.content);

            newSignals.push({
              ts: now,
              type: 'tool_failure',
              tool_use_id: block.tool_use_id,
              error: errorContent.slice(0, 500),
              session_id: data.session_id || null,
              cwd: data.cwd || null,
            });
          }
        }
      } catch {
        // Skip malformed lines (expected for the first truncated line).
      }
    }

    // Resolve tool names from the map built in the same pass.
    for (const signal of newSignals) {
      signal.tool = toolNameMap.get(signal.tool_use_id) || 'unknown';
    }

    // Only load watermark and write signals if there are failures to process.
    if (newSignals.length > 0) {
      const watermark = loadWatermark(data.session_id);
      const fresh = watermark
        ? newSignals.filter(s => !watermark.has(s.tool_use_id))
        : newSignals;

      if (fresh.length > 0) {
        // Batch append: single write for all signals.
        const batch = fresh.map(s => JSON.stringify(s)).join('\n') + '\n';
        fs.appendFileSync(SKILL_SIGNALS, batch);
        capFileIfNeeded(SKILL_SIGNALS, MAX_SKILL_SIGNALS_LINES);
        saveWatermark(data.session_id, capturedIds);
      }
    }

    // Probabilistic cleanup of stale watermark files (1 in 50 invocations).
    if (Math.random() < 0.02) {
      cleanOldWatermarks(7 * 24 * 60 * 60 * 1000);
    }

  } catch (e) {
    // Never block the user's workflow. Log to stderr for diagnostics.
    try { process.stderr.write(`[metame-stop-hook] ${e.message}\n`); } catch {}
  }
  process.exit(0);
});

/**
 * Append a JSON entry to a file, then check cap.
 */
function appendWithCap(filePath, entry, maxLines) {
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  capFileIfNeeded(filePath, maxLines);
}

/**
 * Amortized cap check: only trim when file size suggests overflow.
 */
function capFileIfNeeded(filePath, maxLines) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxLines * 250) {
      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n').filter(Boolean);
      if (allLines.length > maxLines) {
        fs.writeFileSync(filePath, allLines.slice(-maxLines).join('\n') + '\n');
      }
    }
  } catch {
    // Non-fatal.
  }
}

/**
 * Delete watermark files older than maxAge (ms).
 */
function cleanOldWatermarks(maxAge) {
  const wmDir = path.join(METAME_DIR, '.hook_watermarks');
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(wmDir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(wmDir, file);
      try {
        const age = now - fs.statSync(filePath).mtimeMs;
        if (age > maxAge) fs.unlinkSync(filePath);
      } catch { /* skip individual file errors */ }
    }
  } catch { /* wmDir doesn't exist yet — normal */ }
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

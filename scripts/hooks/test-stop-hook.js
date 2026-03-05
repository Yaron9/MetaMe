#!/usr/bin/env node

/**
 * Test harness for stop-session-capture.js
 *
 * Simulates a Stop hook invocation with a mock transcript file
 * containing both successful and failed tool calls.
 *
 * Usage: node scripts/hooks/test-stop-hook.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const METAME_DIR = path.join(os.homedir(), '.metame');
const SESSION_EVENTS = path.join(METAME_DIR, 'session_events.jsonl');
const SKILL_SIGNALS = path.join(METAME_DIR, 'skill_signals.jsonl');
const HOOK_SCRIPT = path.join(__dirname, 'stop-session-capture.js');

// ── Setup: clean test artifacts ──
const testSessionId = `test-${Date.now()}`;
const testTranscript = path.join(os.tmpdir(), `test-transcript-${testSessionId}.jsonl`);
const wmDir = path.join(METAME_DIR, '.hook_watermarks');

// Backup existing files
const backups = {};
for (const f of [SESSION_EVENTS, SKILL_SIGNALS]) {
  if (fs.existsSync(f)) {
    backups[f] = fs.readFileSync(f, 'utf8');
  }
}

// Count existing lines
function countLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

const sessionLinesBefore = countLines(SESSION_EVENTS);
const signalLinesBefore = countLines(SKILL_SIGNALS);

// ── Create mock transcript ──
const transcriptLines = [
  // A successful Bash tool_use + tool_result
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_success_001',
        name: 'Bash',
        input: { command: 'echo hello' }
      }]
    }
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_success_001',
        is_error: false,
        content: 'hello'
      }]
    }
  }),
  // A failed Bash tool_use + tool_result
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_fail_001',
        name: 'Bash',
        input: { command: 'ls /nonexistent' }
      }]
    }
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_fail_001',
        is_error: true,
        content: 'Exit code 1\nls: /nonexistent: No such file or directory'
      }]
    }
  }),
  // A failed Read tool_use + tool_result
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_fail_002',
        name: 'Read',
        input: { file_path: '/tmp/does_not_exist.txt' }
      }]
    }
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_fail_002',
        is_error: true,
        content: 'File does not exist.'
      }]
    }
  }),
  // A successful Read (should NOT be captured)
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_success_002',
        name: 'Read',
        input: { file_path: '/tmp/some_file.txt' }
      }]
    }
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_success_002',
        is_error: false,
        content: 'file contents here'
      }]
    }
  }),
];

fs.writeFileSync(testTranscript, transcriptLines.join('\n') + '\n');

// ── Invoke the hook ──
const hookInput = JSON.stringify({
  session_id: testSessionId,
  transcript_path: testTranscript,
  cwd: '/tmp/test',
  last_assistant_message: 'Test completed successfully with some errors along the way.',
});

console.log('=== Test: Stop Hook Invocation ===\n');

const start = Date.now();
try {
  execSync(`node ${HOOK_SCRIPT}`, {
    input: hookInput,
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error('Hook execution failed:', e.message);
  process.exit(1);
}
const elapsed = Date.now() - start;

console.log(`Execution time: ${elapsed}ms ${elapsed < 50 ? '✅ < 50ms' : '⚠️  > 50ms'}\n`);

// ── Verify results ──
const sessionLinesAfter = countLines(SESSION_EVENTS);
const signalLinesAfter = countLines(SKILL_SIGNALS);

const newSessionLines = sessionLinesAfter - sessionLinesBefore;
const newSignalLines = signalLinesAfter - signalLinesBefore;

console.log(`Session events: +${newSessionLines} lines ${newSessionLines === 1 ? '✅' : '❌ expected 1'}`);
console.log(`Skill signals:  +${newSignalLines} lines ${newSignalLines === 2 ? '✅' : '❌ expected 2'}\n`);

// Read the new entries
if (newSessionLines > 0) {
  const allSessionLines = fs.readFileSync(SESSION_EVENTS, 'utf8').split('\n').filter(Boolean);
  const lastSession = JSON.parse(allSessionLines[allSessionLines.length - 1]);
  console.log('Last session event:');
  console.log(`  session_id: ${lastSession.session_id}`);
  console.log(`  cwd: ${lastSession.cwd}`);
  console.log(`  hint: ${lastSession.hint?.slice(0, 80)}`);
  console.log();
}

if (newSignalLines > 0) {
  const allSignalLines = fs.readFileSync(SKILL_SIGNALS, 'utf8').split('\n').filter(Boolean);
  const newSignals = allSignalLines.slice(-newSignalLines);
  console.log('New skill signals:');
  for (const line of newSignals) {
    const s = JSON.parse(line);
    console.log(`  [${s.tool}] ${s.error.slice(0, 100)}`);
  }
  console.log();
}

// ── Test 2: Idempotency (re-run should NOT produce duplicates) ──
console.log('=== Test: Idempotency (re-run same transcript) ===\n');

const signalLinesBefore2 = countLines(SKILL_SIGNALS);

try {
  execSync(`node ${HOOK_SCRIPT}`, {
    input: hookInput,
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) {
  console.error('Hook re-execution failed:', e.message);
}

const signalLinesAfter2 = countLines(SKILL_SIGNALS);
const duplicateSignals = signalLinesAfter2 - signalLinesBefore2;
// Session events will add +1 (each stop creates a new event), but skill signals should be 0.
console.log(`Duplicate skill signals: ${duplicateSignals} ${duplicateSignals === 0 ? '✅ no duplicates' : '❌ duplicates found!'}\n`);

// ── Cleanup ──
try { fs.unlinkSync(testTranscript); } catch {}
const wmFile = path.join(wmDir, `${testSessionId}.json`);
try { fs.unlinkSync(wmFile); } catch {}

// Remove test entries from signal/session files (restore to original + test entries removed)
function removeTestEntries(filePath, testId) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const cleaned = lines.filter(l => {
      try { return JSON.parse(l).session_id !== testId; } catch { return true; }
    });
    fs.writeFileSync(filePath, cleaned.length > 0 ? cleaned.join('\n') + '\n' : '');
  } catch {}
}

removeTestEntries(SESSION_EVENTS, testSessionId);
removeTestEntries(SKILL_SIGNALS, testSessionId);

console.log('=== All tests completed. Test artifacts cleaned up. ===');

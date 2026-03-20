#!/usr/bin/env node

/**
 * skill-creator Auto-Evolve Hook
 *
 * Runs as a Claude Code "Stop" hook. After each session:
 *   1. Detects which skills were active in this session
 *   2. Extracts tool failures and interaction signals
 *   3. If ANTHROPIC_API_KEY is set: uses Haiku to generate structured insights
 *      Otherwise: persists raw failure signals directly
 *   4. Calls merge_evolution.py + smart_stitch.py to persist into each skill's SKILL.md
 *
 * Zero MetaMe dependency. Self-contained.
 * Performance target: <50ms when no skills detected, <3s with Haiku analysis.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

// Paths derived from __dirname (scripts/) — works regardless of install location
const SKILL_CREATOR_DIR = path.dirname(__dirname);  // scripts/ → skill-creator/
const SKILLS_DIR = path.dirname(SKILL_CREATOR_DIR); // skill-creator/ → skills/
const MERGE_SCRIPT = path.join(SKILL_CREATOR_DIR, 'scripts', 'merge_evolution.py');
const STITCH_SCRIPT = path.join(SKILL_CREATOR_DIR, 'scripts', 'smart_stitch.py');

const TAIL_BYTES = 40 * 1024; // 40KB — covers ~15-25 turns

const IS_CODEX = process.argv.includes('--codex');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  (IS_CODEX ? mainCodex() : mainCC()).catch(() => {}).finally(() => process.exit(0));
});

// ── Claude Code mode: full transcript analysis ────────────────────────────────

async function mainCC() {
  let data;
  try { data = JSON.parse(input); } catch { return; }

  const transcriptPath = data.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const tail = readTail(transcriptPath, TAIL_BYTES);
  if (!tail) return;

  const installedSkills = getInstalledSkills();
  if (installedSkills.length === 0) return;

  const activeSkills = detectActiveSkills(tail, installedSkills);
  if (activeSkills.length === 0) return;

  const failures = extractFailures(tail);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  for (const skillName of activeSkills) {
    const skillDir = path.join(SKILLS_DIR, skillName);
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;

    let experience;
    if (apiKey) {
      experience = await analyzeWithHaiku(skillName, tail, failures, apiKey);
    } else {
      experience = buildRawExperience(failures);
    }

    if (!experience) continue;
    persistExperience(skillDir, experience);
  }
}

// ── Codex CLI mode: per-turn signal capture (no transcript available) ─────────
// Codex notify fires on agent-turn-complete but passes no stdin data.
// We can only record a timestamped turn event — no Haiku analysis possible.

async function mainCodex() {
  const signalFile = path.join(SKILLS_DIR, '.codex_turn_signals.jsonl');
  const entry = JSON.stringify({ ts: new Date().toISOString(), cwd: process.cwd() }) + '\n';
  try { fs.appendFileSync(signalFile, entry); } catch { /* non-fatal */ }
  // No transcript → nothing to evolve right now.
  // Signals accumulate and can be analyzed manually via /evolve.
}

// ── Transcript utilities ──────────────────────────────────────────────────────

function readTail(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(filePath, 'r');
    try { fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size)); }
    finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    // Skip first (possibly truncated) line
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } catch { return null; }
}

function extractFailures(tail) {
  const failures = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_result' && block.is_error === true) {
          const errText = typeof block.content === 'string'
            ? block.content
            : (block.content || []).map(c => c.text || '').join('\n');
          failures.push(errText.slice(0, 300));
        }
      }
    } catch { /* skip */ }
  }
  return failures;
}

// ── Skill detection ───────────────────────────────────────────────────────────

function getInstalledSkills() {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(name => {
      const skillMd = path.join(SKILLS_DIR, name, 'SKILL.md');
      return fs.existsSync(skillMd);
    });
  } catch { return []; }
}

function detectActiveSkills(tail, installedSkills) {
  // A skill is "active" if its name appears in the transcript
  // (skill bodies are injected into the system prompt when triggered)
  return installedSkills.filter(name => tail.includes(name));
}

// ── Haiku analysis ────────────────────────────────────────────────────────────

async function analyzeWithHaiku(skillName, tail, failures, apiKey) {
  // Build a compact summary for Haiku (avoid sending full transcript)
  const truncatedTail = tail.slice(-8000); // last ~8KB for prompt efficiency
  const failureSummary = failures.length > 0
    ? `Tool failures:\n${failures.slice(0, 5).map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : 'No tool failures detected.';

  const prompt = `You are analyzing a Claude Code session to extract experience for improving the "${skillName}" skill.

Session tail (last portion of conversation):
<session>
${truncatedTail.slice(0, 6000)}
</session>

${failureSummary}

Extract only concrete, reusable insights about the "${skillName}" skill. Respond with ONLY a JSON object or the string NO_EVOLUTION:

{
  "preferences": ["user preference observed, e.g. always use X format"],
  "fixes": ["bug or workaround discovered, e.g. path needs quoting on Windows"],
  "custom_prompts": "persistent instruction to inject, if any (or omit)"
}

Rules:
- Only include insights directly related to "${skillName}"
- "preferences": recurring user preferences (omit if none)
- "fixes": concrete bugs/workarounds (omit if none)
- "custom_prompts": only if a specific instruction should always apply (omit otherwise)
- If nothing useful found, respond: NO_EVOLUTION`;

  try {
    const result = await callHaiku(prompt, apiKey);
    if (!result || result.trim() === 'NO_EVOLUTION') return null;
    const json = result.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const parsed = JSON.parse(json);
    // Only return if there's actual content
    const hasContent = (parsed.preferences?.length > 0) ||
                       (parsed.fixes?.length > 0) ||
                       parsed.custom_prompts;
    return hasContent ? parsed : null;
  } catch { return null; }
}

function callHaiku(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 10000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.content?.[0]?.text || null);
        } catch { resolve(null); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Fallback: raw failure signals (no API key) ────────────────────────────────

function buildRawExperience(failures) {
  if (failures.length === 0) return null;
  return {
    fixes: failures.slice(0, 3).map(f => `[auto-captured] ${f.slice(0, 150)}`),
  };
}

// ── Persist ───────────────────────────────────────────────────────────────────

function persistExperience(skillDir, experience) {
  try {
    const jsonStr = JSON.stringify(experience).replace(/'/g, "\\'");
    execSync(`python3 "${MERGE_SCRIPT}" "${skillDir}" '${jsonStr}'`, { stdio: 'ignore' });
    execSync(`python3 "${STITCH_SCRIPT}" "${skillDir}"`, { stdio: 'ignore' });
  } catch { /* non-fatal */ }
}

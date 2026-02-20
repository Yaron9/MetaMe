#!/usr/bin/env node

/**
 * MetaMe Skill Evolution Module
 *
 * Two-tier skill evolution system that mirrors the metacognition pipeline:
 *
 * HOT PATH (immediate, zero API cost):
 *   - After each Claude task completes in daemon.js
 *   - Heuristic rules detect skill failures, user complaints, skill decay
 *   - Writes to evolution_queue.yaml for immediate action
 *
 * COLD PATH (batched, Haiku-powered):
 *   - Piggybacks on distill.js (every 4h or on launch)
 *   - Haiku analyzes accumulated skill signals for nuanced insights
 *   - Merges evolution data into skill's evolution.json + SKILL.md
 *
 * Data flow:
 *   Claude completes → extractSkillSignal() → skill_signals.jsonl
 *                    → checkHotEvolution() → evolution_queue.yaml
 *                    → [distill.js] distillSkills() → evolution.json → SKILL.md
 *
 * SELF-EVOLUTION:
 *   All thresholds, rules, and even the Haiku prompt live in evolution_policy.yaml.
 *   The cold path periodically evaluates its own effectiveness and rewrites the policy.
 *   Nothing is hardcoded that can't be changed by the system itself.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const SKILL_SIGNAL_FILE = path.join(METAME_DIR, 'skill_signals.jsonl');
const EVOLUTION_QUEUE_FILE = path.join(METAME_DIR, 'evolution_queue.yaml');
const EVOLUTION_POLICY_FILE = path.join(METAME_DIR, 'evolution_policy.yaml');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');

// Skill directories (check both locations)
const SKILL_DIRS = [
  path.join(HOME, '.claude', 'skills'),
  path.join(HOME, '.opencode', 'skills'),
];

// ─────────────────────────────────────────────
// Policy: all tunable params, self-modifiable
// ─────────────────────────────────────────────

const DEFAULT_POLICY = {
  version: 1,

  // Hot path params
  hot_failure_threshold: 3,
  hot_failure_window_minutes: 30,
  complaint_patterns: ['不好用', '不对', 'wrong', 'broken', "doesn't work", '有问题', '不行', 'bug', '失败'],
  missing_skill_patterns: ['没有找到.{0,10}技能', 'skill not found', 'no skill.{0,10}(available|installed)', '能力不足', '找不到'],

  // Cold path params
  min_signals_for_distill: 3,
  max_signals_buffer: 200,
  min_evidence_for_update: 2,
  min_evidence_for_gap: 3,
  max_updates_per_analysis: 3,
  max_gaps_per_analysis: 2,

  // Self-evaluation
  self_eval_interval: 5,           // every N cold-path runs, evaluate policy effectiveness
  cold_path_run_count: 0,

  // Haiku prompt (the system can rewrite this)
  prompt_template: `You are a skill evolution analyzer for an AI coding assistant called MetaMe.
Analyze recent skill usage signals and provide actionable evolution insights.

INSTALLED SKILLS:
\${installedSkills}

RECENT SKILL SIGNALS (\${signalCount} interactions):
\${signalSummary}
\${patternContext}

RULES:
1. Only reference skills in INSTALLED SKILLS or explicitly invoked in signals.
2. For "updates": provide specific, concrete improvements (not vague suggestions).
3. For "missing_skills": only when user repeatedly attempted a task with no matching skill (\${minEvidenceForGap}+ signals).
4. Minimum evidence: updates need \${minEvidenceForUpdate}+ related signals, missing_skills need \${minEvidenceForGap}+ failed attempts.
5. Do NOT suggest for one-off tasks.
6. Maximum \${maxUpdates} updates and \${maxGaps} missing_skills per analysis.

Respond with ONLY a JSON code block:
\\\`\\\`\\\`json
{
  "updates": [
    {
      "skill_name": "exact-installed-skill-name",
      "category": "fix|preference|context",
      "insight": "specific actionable text",
      "evidence_count": 3
    }
  ],
  "missing_skills": [
    {
      "task_pattern": "what the user keeps trying to do",
      "search_query": "suggested search term",
      "evidence_count": 4
    }
  ]
}
\\\`\\\`\\\`

If no actionable insights, respond with exactly: NO_EVOLUTION`,
};

function loadPolicy() {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return { ...DEFAULT_POLICY }; }

  try {
    if (!fs.existsSync(EVOLUTION_POLICY_FILE)) {
      // First run: write default policy
      savePolicy(yaml, DEFAULT_POLICY);
      return { ...DEFAULT_POLICY };
    }
    const content = fs.readFileSync(EVOLUTION_POLICY_FILE, 'utf8');
    const loaded = yaml.load(content) || {};
    // Merge with defaults (new fields auto-added on upgrade)
    return { ...DEFAULT_POLICY, ...loaded };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function savePolicy(yaml, policy) {
  try {
    if (!fs.existsSync(METAME_DIR)) fs.mkdirSync(METAME_DIR, { mode: 0o700, recursive: true });
    fs.writeFileSync(EVOLUTION_POLICY_FILE, yaml.dump(policy, { lineWidth: 120 }), 'utf8');
  } catch {}
}

// ─────────────────────────────────────────────
// Signal Extraction (called from daemon.js)
// ─────────────────────────────────────────────

/**
 * Extract structured skill signal from a completed Claude task.
 * Returns null if the interaction has no skill-relevant data.
 */
function extractSkillSignal(prompt, output, error, files, cwd, toolUsageLog) {
  // Only capture if skills were involved OR task failed
  const skills = [];
  const tools = [];

  if (Array.isArray(toolUsageLog)) {
    for (const entry of toolUsageLog) {
      if (entry.tool === 'Skill' && entry.skill) {
        skills.push(entry.skill);
      }
      tools.push({ name: entry.tool, context: entry.context || null });
    }
  }

  // Also detect skills from output text (fallback if toolUsageLog is sparse)
  if (output) {
    const skillMatches = output.match(/🔧 Skill: 「([^」]+)」/g);
    if (skillMatches) {
      for (const m of skillMatches) {
        const name = m.match(/「([^」]+)」/)?.[1];
        if (name && !skills.includes(name)) skills.push(name);
      }
    }
  }

  const hasSkills = skills.length > 0;
  const hasError = !!error;
  const hasToolFailure = output && /(?:failed|error|not found|not available|skill.{0,20}(?:missing|absent|not.{0,10}install))/i.test(output);

  // Skip if no skill involvement and no failure
  if (!hasSkills && !hasError && !hasToolFailure) return null;

  return {
    ts: new Date().toISOString(),
    prompt: (prompt || '').substring(0, 500),
    skills_invoked: skills,
    tools_used: tools.slice(0, 20), // cap for storage
    error: error ? error.substring(0, 500) : null,
    has_tool_failure: !!hasToolFailure,
    files_modified: (files || []).slice(0, 10),
    cwd: cwd || null,
    outcome: error ? 'error' : (output ? 'success' : 'empty'),
  };
}

/**
 * Append a skill signal to the JSONL buffer.
 */
function appendSkillSignal(signal) {
  if (!signal) return;
  try {
    if (!fs.existsSync(METAME_DIR)) fs.mkdirSync(METAME_DIR, { mode: 0o700, recursive: true });

    // Append
    fs.appendFileSync(SKILL_SIGNAL_FILE, JSON.stringify(signal) + '\n', 'utf8');

    // Truncate if over limit (keep newest)
    const content = fs.readFileSync(SKILL_SIGNAL_FILE, 'utf8').trim();
    const lines = content.split('\n');
    const policy = loadPolicy();
    if (lines.length > policy.max_signals_buffer) {
      fs.writeFileSync(SKILL_SIGNAL_FILE, lines.slice(-policy.max_signals_buffer).join('\n') + '\n', 'utf8');
    }
  } catch {
    // Non-fatal
  }
}

// ─────────────────────────────────────────────
// Hot Path: Heuristic Evolution (zero API cost)
// ─────────────────────────────────────────────

/**
 * Immediate heuristic checks after each task.
 * Detects acute issues that shouldn't wait for 4h distill cycle.
 */
function checkHotEvolution(signal) {
  if (!signal) return;

  let yaml;
  try { yaml = require('js-yaml'); } catch { return; }

  const policy = loadPolicy();
  const queue = loadEvolutionQueue(yaml);
  const windowMs = policy.hot_failure_window_minutes * 60 * 1000;

  // Rule 1: Repeated skill failures → queue discovery
  if (signal.error || signal.has_tool_failure) {
    const recentFailures = readRecentSignals()
      .filter(s => {
        if (!s.error && !s.has_tool_failure) return false;
        return (Date.now() - new Date(s.ts).getTime()) < windowMs;
      });

    const failCounts = {};
    for (const s of recentFailures) {
      for (const sk of (s.skills_invoked || [])) {
        failCounts[sk] = (failCounts[sk] || 0) + 1;
      }
    }

    for (const [skillName, count] of Object.entries(failCounts)) {
      if (count >= policy.hot_failure_threshold) {
        addToQueue(queue, {
          type: 'skill_fix',
          skill_name: skillName,
          reason: `Failed ${count} times in ${policy.hot_failure_window_minutes} minutes`,
          evidence_count: count,
        });
      }
    }
  }

  // Rule 2: User complaints about a skill
  const complaintRe = new RegExp(policy.complaint_patterns.join('|'), 'i');
  if (signal.prompt && complaintRe.test(signal.prompt) && signal.skills_invoked.length > 0) {
    for (const sk of signal.skills_invoked) {
      addToQueue(queue, {
        type: 'user_complaint',
        skill_name: sk,
        reason: `User complaint: "${signal.prompt.substring(0, 100)}"`,
        evidence_count: 1,
      });
    }
  }

  // Rule 3: Missing skill detection
  const missingRe = new RegExp(policy.missing_skill_patterns.join('|'), 'i');
  if (signal.outcome !== 'success' && signal.prompt && missingRe.test((signal.error || '') + (signal.prompt || ''))) {
    addToQueue(queue, {
      type: 'skill_gap',
      skill_name: null,
      reason: `Possible missing capability: "${signal.prompt.substring(0, 150)}"`,
      search_hint: signal.prompt.substring(0, 80),
      evidence_count: 1,
    });
  }

  saveEvolutionQueue(yaml, queue);
}

// ─────────────────────────────────────────────
// Cold Path: Haiku-Powered Analysis
// (called from distill.js)
// ─────────────────────────────────────────────

/**
 * Batch-analyze accumulated skill signals via Haiku.
 * Returns { updates, missing_skills } or null if nothing to process.
 */
function distillSkills() {
  const { execSync } = require('child_process');
  let yaml;
  try { yaml = require('js-yaml'); } catch { return null; }

  // Read signals
  if (!fs.existsSync(SKILL_SIGNAL_FILE)) return null;
  const content = fs.readFileSync(SKILL_SIGNAL_FILE, 'utf8').trim();
  if (!content) return null;

  const lines = content.split('\n');
  if (lines.length < MIN_SIGNALS_FOR_DISTILL) return null;

  const signals = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (signals.length < MIN_SIGNALS_FOR_DISTILL) return null;

  // Get installed skills list
  const installedSkills = listInstalledSkills();
  if (installedSkills.length === 0) {
    // No skills installed, nothing to evolve
    clearSignals();
    return null;
  }

  // Read metacognition patterns for bridge context
  let patternContext = '';
  try {
    const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8'));
    const patterns = (profile?.growth?.patterns || [])
      .filter(p => ['avoidance', 'friction', 'efficiency'].includes(p.type))
      .map(p => `[${p.type}] ${p.summary}`);
    if (patterns.length > 0) {
      patternContext = `\nBEHAVIORAL CONTEXT (from metacognition):\n${patterns.join('\n')}`;
    }
  } catch {}

  // Build signal summary (compact)
  const signalSummary = signals.map((s, i) => {
    const parts = [`${i + 1}. [${s.outcome}]`];
    if (s.skills_invoked?.length) parts.push(`skills=[${s.skills_invoked.join(',')}]`);
    if (s.error) parts.push(`error="${s.error.substring(0, 100)}"`);
    if (s.has_tool_failure) parts.push('tool_failure=true');
    parts.push(`prompt="${s.prompt?.substring(0, 80)}"`);
    return parts.join(' ');
  }).join('\n');

  const prompt = `You are a skill evolution analyzer for an AI coding assistant called MetaMe.
Analyze recent skill usage signals and provide actionable evolution insights.

INSTALLED SKILLS:
${installedSkills.map(s => `- ${s.name}: ${s.description || 'no description'}`).join('\n')}

RECENT SKILL SIGNALS (${signals.length} interactions):
${signalSummary}
${patternContext}

RULES:
1. Only reference skills in INSTALLED SKILLS or explicitly invoked in signals.
2. For "updates": provide specific, concrete improvements (not vague suggestions).
3. For "missing_skills": only when user repeatedly attempted a task with no matching skill (3+ signals).
4. Minimum evidence: updates need 2+ related signals, missing_skills need 3+ failed attempts.
5. Do NOT suggest for one-off tasks.
6. Maximum 3 updates and 2 missing_skills per analysis.

Respond with ONLY a JSON code block:
\`\`\`json
{
  "updates": [
    {
      "skill_name": "exact-installed-skill-name",
      "category": "fix|preference|context",
      "insight": "specific actionable text",
      "evidence_count": 3
    }
  ],
  "missing_skills": [
    {
      "task_pattern": "what the user keeps trying to do",
      "search_query": "suggested search term",
      "evidence_count": 4
    }
  ]
}
\`\`\`

If no actionable insights, respond with exactly: NO_EVOLUTION`;

  try {
    // Provider env for distill
    let distillEnv = {};
    try {
      const { buildDistillEnv } = require('./providers');
      distillEnv = buildDistillEnv();
    } catch {}

    const result = execSync('claude -p --model haiku --no-session-persistence', {
      input: prompt,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, ...distillEnv },
    });

    if (result.includes('NO_EVOLUTION')) {
      clearSignals();
      return { updates: [], missing_skills: [] };
    }

    // Parse JSON from response
    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) {
      clearSignals();
      return null;
    }

    const evolution = JSON.parse(jsonMatch[1]);
    const updates = Array.isArray(evolution.updates) ? evolution.updates : [];
    const missingSkills = Array.isArray(evolution.missing_skills) ? evolution.missing_skills : [];

    // Apply updates to skill evolution.json files
    for (const update of updates) {
      if (!update.skill_name || !update.insight) continue;
      const skillDir = findSkillDir(update.skill_name);
      if (!skillDir) continue;

      const evoData = {};
      const key = update.category === 'fix' ? 'fixes'
        : update.category === 'preference' ? 'preferences'
        : 'contexts';
      evoData[key] = [update.insight];

      mergeEvolution(skillDir, evoData);
      smartStitch(skillDir);
    }

    // Queue missing skills for user notification
    if (missingSkills.length > 0) {
      const queue = loadEvolutionQueue(yaml);
      for (const ms of missingSkills) {
        addToQueue(queue, {
          type: 'skill_gap',
          skill_name: null,
          reason: `Haiku analysis: ${ms.task_pattern}`,
          search_hint: ms.search_query,
          evidence_count: ms.evidence_count || 3,
        });
      }
      saveEvolutionQueue(yaml, queue);
    }

    clearSignals();
    return { updates, missing_skills: missingSkills };

  } catch (err) {
    // Non-fatal: don't clear signals so they can be retried
    try { console.log(`⚠️ Skill evolution analysis failed: ${err.message}`); } catch {}
    return null;
  }
}

// ─────────────────────────────────────────────
// Evolution Queue Management
// ─────────────────────────────────────────────

function loadEvolutionQueue(yaml) {
  try {
    if (!fs.existsSync(EVOLUTION_QUEUE_FILE)) return { items: [] };
    const content = fs.readFileSync(EVOLUTION_QUEUE_FILE, 'utf8');
    const data = yaml.load(content);
    return data && Array.isArray(data.items) ? data : { items: [] };
  } catch {
    return { items: [] };
  }
}

function saveEvolutionQueue(yaml, queue) {
  try {
    fs.writeFileSync(EVOLUTION_QUEUE_FILE, yaml.dump(queue, { lineWidth: -1 }), 'utf8');
  } catch {}
}

function addToQueue(queue, entry) {
  // Dedup by type + skill_name (update existing instead of adding duplicate)
  const existing = queue.items.find(i =>
    i.type === entry.type && i.skill_name === entry.skill_name && i.status === 'pending'
  );

  if (existing) {
    existing.evidence_count = (existing.evidence_count || 0) + (entry.evidence_count || 1);
    existing.last_seen = new Date().toISOString();
    return;
  }

  queue.items.push({
    ...entry,
    detected: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    status: 'pending',
  });

  // Keep queue manageable
  if (queue.items.length > 50) {
    queue.items = queue.items.slice(-50);
  }
}

/**
 * Check evolution queue and return items ready for user notification.
 * Called from daemon.js heartbeat.
 * Returns array of notification-ready items (marks them as 'notified').
 */
function checkEvolutionQueue() {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return []; }

  const queue = loadEvolutionQueue(yaml);
  const pendingItems = queue.items.filter(i => i.status === 'pending');
  if (pendingItems.length === 0) return [];

  const notifications = [];

  for (const item of pendingItems) {
    // Require minimum evidence before notifying
    const minEvidence = item.type === 'skill_gap' ? 3 : 2;
    if ((item.evidence_count || 1) < minEvidence) continue;

    item.status = 'notified';
    item.notified_at = new Date().toISOString();
    notifications.push(item);
  }

  // Prune old resolved items (> 30 days)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  queue.items = queue.items.filter(i =>
    i.status === 'pending' || i.status === 'notified' ||
    (new Date(i.last_seen || i.detected).getTime() > cutoff)
  );

  if (notifications.length > 0) {
    saveEvolutionQueue(yaml, queue);
  }

  return notifications;
}

/**
 * Mark a queue item as resolved (installed or dismissed).
 */
function resolveQueueItem(type, skillName, resolution) {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return; }

  const queue = loadEvolutionQueue(yaml);
  const item = queue.items.find(i =>
    i.type === type && i.skill_name === skillName &&
    (i.status === 'pending' || i.status === 'notified')
  );
  if (item) {
    item.status = resolution; // 'installed' | 'dismissed'
    item.resolved_at = new Date().toISOString();
    saveEvolutionQueue(yaml, queue);
  }
}

// ─────────────────────────────────────────────
// Evolution.json Merge (JS port of merge_evolution.py)
// ─────────────────────────────────────────────

function mergeEvolution(skillDir, newData) {
  const evoPath = path.join(skillDir, 'evolution.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(evoPath, 'utf8')); } catch {}

  current.last_updated = new Date().toISOString();

  for (const key of ['preferences', 'fixes', 'contexts']) {
    if (!newData[key]) continue;
    const existing = current[key] || [];
    const existingSet = new Set(existing);
    current[key] = [...existing, ...newData[key].filter(item => !existingSet.has(item))];
  }

  if (newData.custom_prompts) {
    current.custom_prompts = newData.custom_prompts;
  }

  fs.writeFileSync(evoPath, JSON.stringify(current, null, 2), 'utf8');
}

// ─────────────────────────────────────────────
// Smart Stitch (JS port of smart_stitch.py)
// ─────────────────────────────────────────────

function smartStitch(skillDir) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const evoPath = path.join(skillDir, 'evolution.json');

  if (!fs.existsSync(skillMdPath) || !fs.existsSync(evoPath)) return;

  let data;
  try { data = JSON.parse(fs.readFileSync(evoPath, 'utf8')); } catch { return; }

  // Build evolution section
  const sections = [];
  sections.push('\n\n## User-Learned Best Practices & Constraints');
  sections.push('\n> **Auto-Generated Section**: Maintained by skill-evolution-manager. Do not edit manually.');

  if (data.preferences?.length) {
    sections.push('\n### User Preferences');
    for (const item of data.preferences) sections.push(`- ${item}`);
  }

  if (data.fixes?.length) {
    sections.push('\n### Known Fixes & Workarounds');
    for (const item of data.fixes) sections.push(`- ${item}`);
  }

  if (data.custom_prompts) {
    sections.push('\n### Custom Instruction Injection');
    sections.push(`\n${data.custom_prompts}`);
  }

  const evolutionBlock = sections.join('\n');

  let content = fs.readFileSync(skillMdPath, 'utf8');
  const pattern = /(\n+## User-Learned Best Practices & Constraints[\s\S]*$)/;

  if (pattern.test(content)) {
    content = content.replace(pattern, evolutionBlock);
  } else {
    content = content + evolutionBlock;
  }

  fs.writeFileSync(skillMdPath, content, 'utf8');
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function readRecentSignals() {
  try {
    if (!fs.existsSync(SKILL_SIGNAL_FILE)) return [];
    const content = fs.readFileSync(SKILL_SIGNAL_FILE, 'utf8').trim();
    if (!content) return [];
    return content.split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function clearSignals() {
  try { fs.writeFileSync(SKILL_SIGNAL_FILE, '', 'utf8'); } catch {}
}

function listInstalledSkills() {
  const skills = [];
  for (const dir of SKILL_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const name of fs.readdirSync(dir)) {
        const skillMd = path.join(dir, name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        // Read first line for description
        const content = fs.readFileSync(skillMd, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
        skills.push({ name, description: (firstLine || '').substring(0, 100), dir: path.join(dir, name) });
      }
    } catch {}
  }
  return skills;
}

function findSkillDir(skillName) {
  for (const dir of SKILL_DIRS) {
    const candidate = path.join(dir, skillName);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  return null;
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  extractSkillSignal,
  appendSkillSignal,
  checkHotEvolution,
  distillSkills,
  checkEvolutionQueue,
  resolveQueueItem,
  mergeEvolution,
  smartStitch,
  listInstalledSkills,
};

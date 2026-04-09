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
 *   - Runs as standalone heartbeat script task (skill-evolve, default 6h)
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
const { appendChange } = require('./skill-changelog');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const SKILL_SIGNAL_FILE = path.join(METAME_DIR, 'skill_signals.jsonl');
const SKILL_SIGNAL_OVERFLOW_FILE = path.join(METAME_DIR, 'skill_signals.overflow.jsonl');
const SKILL_SIGNAL_LOCK_FILE = path.join(METAME_DIR, 'skill_signals.lock');
const EVOLUTION_QUEUE_FILE = path.join(METAME_DIR, 'evolution_queue.yaml');
const EVOLUTION_POLICY_FILE = path.join(METAME_DIR, 'evolution_policy.yaml');
const WORKFLOW_SKETCHES_FILE = path.join(METAME_DIR, 'workflow_sketches.yaml');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');

// Read-only exploration tools — excluded from workflow candidate detection
const READONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'ListDir', 'ListFiles',
  'ReadFile', 'GrepSearch', 'SearchFiles',
]);

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

  // Workflow discovery
  workflow_discovery_interval: 2,   // every N cold-path cycles
  min_signals_for_workflow: 3,      // minimum workflow_candidate signals to analyze
  workflow_proposal_threshold: 4,   // occurrence_count needed to propose
  workflow_min_confidence: 0.7,     // Haiku confidence threshold
  workflow_max_sketches: 10,        // max persisted sketches
  workflow_stale_days: 14,          // auto-purge after N days without new occurrence

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

  workflow_prompt_template: `You are a workflow pattern analyzer for an AI assistant called MetaMe.
Analyze recent multi-tool interaction signals and cluster them into recurring workflow patterns.

KNOWN SKETCHES (existing pattern pool):
\${knownSketches}

NEW SIGNALS (workflow candidates):
\${workflowSignals}

CLUSTERING RULES (MUST follow):
1. EXISTING SKETCHES are your "known pattern pool". For each new signal, FIRST try to match it to an existing sketch.
2. If a signal matches an existing sketch: output that sketch's EXACT ID, increment occurrence_count by 1, append the signal's prompt to example_prompts.
3. Only create a NEW sketch (id: null) when the signal clearly represents a workflow NOT covered by any existing sketch.
4. A workflow must involve 2+ distinct ACTION steps (search→summarize→post). Pure exploration (read files, search code) is NOT a workflow.
5. Do NOT rephrase existing sketch patterns — preserve them exactly.

Respond with ONLY a JSON code block:
\\\`\\\`\\\`json
[
  {
    "id": "existing-sketch-id-or-null",
    "pattern": "description of the workflow (Chinese preferred)",
    "tools_signature": ["WebSearch", "Bash"],
    "example_prompts": ["user prompt example"],
    "occurrence_count": 1,
    "confidence": 0.8
  }
]
\\\`\\\`\\\`

If no meaningful workflows found, respond with exactly: NO_WORKFLOWS`,
};

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return Math.max(min, Math.min(max, i));
}

function sanitizePatternList(value, fallback) {
  const list = Array.isArray(value) ? value : fallback;
  const clean = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const p = v.trim();
    if (!p || p.length > 300) continue;
    try {
      // Validate regex compileability once so hot path won't crash at runtime.
      // eslint-disable-next-line no-new
      new RegExp(p, 'i');
      clean.push(p);
    } catch { /* invalid pattern */ }
  }
  return clean.length > 0 ? clean : fallback.slice();
}

function sanitizePolicy(input) {
  const merged = { ...DEFAULT_POLICY, ...(input && typeof input === 'object' ? input : {}) };
  const policy = {
    ...merged,
    version: clampInt(merged.version, DEFAULT_POLICY.version, 1, 1000000),
    hot_failure_threshold: clampInt(merged.hot_failure_threshold, DEFAULT_POLICY.hot_failure_threshold, 1, 50),
    hot_failure_window_minutes: clampInt(merged.hot_failure_window_minutes, DEFAULT_POLICY.hot_failure_window_minutes, 1, 24 * 60),
    min_signals_for_distill: clampInt(merged.min_signals_for_distill, DEFAULT_POLICY.min_signals_for_distill, 1, 5000),
    max_signals_buffer: clampInt(merged.max_signals_buffer, DEFAULT_POLICY.max_signals_buffer, 20, 20000),
    min_evidence_for_update: clampInt(merged.min_evidence_for_update, DEFAULT_POLICY.min_evidence_for_update, 1, 20),
    min_evidence_for_gap: clampInt(merged.min_evidence_for_gap, DEFAULT_POLICY.min_evidence_for_gap, 1, 20),
    max_updates_per_analysis: clampInt(merged.max_updates_per_analysis, DEFAULT_POLICY.max_updates_per_analysis, 1, 20),
    max_gaps_per_analysis: clampInt(merged.max_gaps_per_analysis, DEFAULT_POLICY.max_gaps_per_analysis, 1, 20),
    workflow_discovery_interval: clampInt(merged.workflow_discovery_interval, DEFAULT_POLICY.workflow_discovery_interval, 1, 100),
    min_signals_for_workflow: clampInt(merged.min_signals_for_workflow, DEFAULT_POLICY.min_signals_for_workflow, 1, 100),
    workflow_proposal_threshold: clampInt(merged.workflow_proposal_threshold, DEFAULT_POLICY.workflow_proposal_threshold, 2, 50),
    workflow_min_confidence: Math.max(0.1, Math.min(1.0, Number(merged.workflow_min_confidence) || DEFAULT_POLICY.workflow_min_confidence)),
    workflow_max_sketches: clampInt(merged.workflow_max_sketches, DEFAULT_POLICY.workflow_max_sketches, 1, 50),
    workflow_stale_days: clampInt(merged.workflow_stale_days, DEFAULT_POLICY.workflow_stale_days, 1, 365),
    self_eval_interval: clampInt(merged.self_eval_interval, DEFAULT_POLICY.self_eval_interval, 1, 1000),
    cold_path_run_count: clampInt(merged.cold_path_run_count, DEFAULT_POLICY.cold_path_run_count, 0, 1000000),
    complaint_patterns: sanitizePatternList(merged.complaint_patterns, DEFAULT_POLICY.complaint_patterns),
    missing_skill_patterns: sanitizePatternList(merged.missing_skill_patterns, DEFAULT_POLICY.missing_skill_patterns),
    prompt_template: (typeof merged.prompt_template === 'string' && merged.prompt_template.trim())
      ? merged.prompt_template
      : DEFAULT_POLICY.prompt_template,
    workflow_prompt_template: (typeof merged.workflow_prompt_template === 'string' && merged.workflow_prompt_template.trim())
      ? merged.workflow_prompt_template
      : DEFAULT_POLICY.workflow_prompt_template,
  };
  return policy;
}

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
    return sanitizePolicy(loaded);
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function savePolicy(yaml, policy) {
  try {
    if (!fs.existsSync(METAME_DIR)) fs.mkdirSync(METAME_DIR, { mode: 0o700, recursive: true });
    fs.writeFileSync(EVOLUTION_POLICY_FILE, yaml.dump(sanitizePolicy(policy), { lineWidth: 120 }), 'utf8');
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
  const outputText = typeof output === 'string' ? output : '';
  const hasToolFailure = /(?:failed|error|not found|not available|skill.{0,20}(?:missing|absent|not.{0,10}install))/i.test(outputText);

  // Workflow candidate detection: multi-tool chain with at least 1 action tool
  const toolNames = tools.map(t => t.name).filter(Boolean);
  const hasActionTool = toolNames.some(n => !READONLY_TOOLS.has(n));
  const isWorkflowCandidate = !hasSkills && !hasError && !hasToolFailure &&
    hasActionTool && toolNames.length >= 2;

  // Skip if no skill involvement, no failure, and not a workflow candidate
  if (!hasSkills && !hasError && !hasToolFailure && !isWorkflowCandidate) return null;

  return {
    ts: new Date().toISOString(),
    prompt: (prompt || '').substring(0, 500),
    skills_invoked: skills,
    tools_used: tools.slice(0, 20), // cap for storage
    error: error ? error.substring(0, 500) : null,
    output_excerpt: outputText.substring(0, 500),
    has_tool_failure: !!hasToolFailure,
    files_modified: (files || []).slice(0, 10),
    cwd: cwd || null,
    outcome: (hasError || hasToolFailure) ? 'error' : (outputText ? 'success' : 'empty'),
    workflow_candidate: isWorkflowCandidate || undefined,
  };
}

/**
 * Append a skill signal to the JSONL buffer.
 */
function withSkillSignalLock(fn) {
  if (!fs.existsSync(METAME_DIR)) fs.mkdirSync(METAME_DIR, { mode: 0o700, recursive: true });
  const maxRetry = 80;
  const retryMs = 8;
  const staleMs = 30 * 1000;

  let acquired = false;
  for (let i = 0; i < maxRetry; i++) {
    try {
      const fd = fs.openSync(SKILL_SIGNAL_LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(SKILL_SIGNAL_LOCK_FILE).mtimeMs;
        if (age > staleMs) {
          fs.unlinkSync(SKILL_SIGNAL_LOCK_FILE);
          continue;
        }
      } catch { /* lock released elsewhere */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }

  if (!acquired) return false;
  try {
    fn();
    return true;
  } finally {
    try { fs.unlinkSync(SKILL_SIGNAL_LOCK_FILE); } catch {}
  }
}

function writeSkillSignalLines(lines) {
  const tmp = SKILL_SIGNAL_FILE + `.tmp.${process.pid}`;
  const content = Array.isArray(lines) && lines.length > 0 ? lines.join('\n') + '\n' : '';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, SKILL_SIGNAL_FILE);
}

function appendSkillSignal(signal) {
  if (!signal) return;
  try {
    const payload = JSON.stringify(signal);
    const policy = loadPolicy();

    const locked = withSkillSignalLock(() => {
      let lines = [];
      try {
        lines = fs.readFileSync(SKILL_SIGNAL_FILE, 'utf8').split('\n').filter(Boolean);
      } catch { /* first write */ }

      // Drain overflow written during prior lock-contention periods.
      // unlink AFTER writeSkillSignalLines succeeds — crash-safe ordering.
      let overflowDrained = false;
      try {
        const overflowLines = fs.readFileSync(SKILL_SIGNAL_OVERFLOW_FILE, 'utf8').split('\n').filter(Boolean);
        if (overflowLines.length > 0) {
          lines = lines.concat(overflowLines);
          overflowDrained = true;
        }
      } catch { /* no overflow file — normal case */ }

      lines.push(payload);
      if (lines.length > policy.max_signals_buffer) {
        lines = lines.slice(-policy.max_signals_buffer);
      }
      writeSkillSignalLines(lines);
      // Unlink overflow only after main file is safely written.
      if (overflowDrained) {
        try { fs.unlinkSync(SKILL_SIGNAL_OVERFLOW_FILE); } catch { /* already gone */ }
      }
    });

    if (!locked) {
      // Last-resort fallback: write to overflow side-file so the next lock-holder
      // can drain and apply max_signals_buffer cap — never bypassing buffer rules.
      // Guard against unbounded growth: drop entry if overflow already at cap.
      try {
        const ofLines = fs.readFileSync(SKILL_SIGNAL_OVERFLOW_FILE, 'utf8').split('\n').filter(Boolean);
        if (ofLines.length >= policy.max_signals_buffer) return;
      } catch { /* overflow file doesn't exist yet */ }
      fs.appendFileSync(SKILL_SIGNAL_OVERFLOW_FILE, payload + '\n', 'utf8');
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
  let complaintRe;
  try {
    complaintRe = new RegExp(policy.complaint_patterns.join('|'), 'i');
  } catch {
    complaintRe = new RegExp(DEFAULT_POLICY.complaint_patterns.join('|'), 'i');
  }
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
  let missingRe;
  try {
    missingRe = new RegExp(policy.missing_skill_patterns.join('|'), 'i');
  } catch {
    missingRe = new RegExp(DEFAULT_POLICY.missing_skill_patterns.join('|'), 'i');
  }
  const missText = [(signal.error || ''), (signal.prompt || ''), (signal.output_excerpt || '')].join('\n');
  const hasMissingPattern = missingRe.test(missText);
  const hasExplicitSkillMiss = signal.has_tool_failure &&
    /skill|技能|能力/i.test(missText) &&
    /not found|missing|absent|no skill|找不到|没有找到|能力不足/i.test(missText);
  if (signal.prompt && (hasMissingPattern || hasExplicitSkillMiss)) {
    addToQueue(queue, {
      type: 'skill_gap',
      skill_name: null,
      reason: `Possible missing capability: "${signal.prompt.substring(0, 150)}"`,
      search_hint: signal.prompt.substring(0, 80),
      evidence_count: 1,
    });
  }

  saveEvolutionQueue(yaml, queue);

  // Log hot detections to changelog
  if (signal.error || signal.has_tool_failure) {
    for (const sk of (signal.skills_invoked || [])) {
      appendChange('hot_detected', sk, `failure detected: ${(signal.error || 'tool_failure').substring(0, 80)}`);
    }
  }

  // Rule 4: Track insight outcomes (success/failure per skill)
  if (signal.skills_invoked && signal.skills_invoked.length > 0) {
    const isSuccess = signal.outcome === 'success' && !signal.error && !signal.has_tool_failure;
    const isFail = !isSuccess && (signal.error || signal.has_tool_failure ||
      (signal.prompt && complaintRe.test(signal.prompt)));
    if (isSuccess || isFail) {
      for (const sk of signal.skills_invoked) {
        const skillDir = findSkillDir(sk);
        if (skillDir) trackInsightOutcome(skillDir, isSuccess, signal);
      }
    }
  }
}

/**
 * Update insight outcome stats in evolution.json for a skill.
 * Tracks success_count, fail_count, last_applied_at per insight text.
 */
const INSIGHT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where',
  'user', 'skill', 'meta', 'metame', 'should', 'always', 'never', 'please',
  '问题', '用户', '技能', '需要', '应该', '这个', '那个', '以及', '如果', '然后',
]);

function extractInsightTokens(text) {
  const raw = String(text || '').toLowerCase();
  const en = raw.match(/[a-z][a-z0-9_.-]{2,}/g) || [];
  const zh = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const tokens = [...en, ...zh]
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !INSIGHT_STOPWORDS.has(t));
  return [...new Set(tokens)];
}

function pickMatchedInsights(allInsights, signal) {
  if (!signal || !Array.isArray(allInsights) || allInsights.length === 0) return [];

  const context = [
    signal.prompt || '',
    signal.error || '',
    signal.output_excerpt || '',
    ...(Array.isArray(signal.tools_used) ? signal.tools_used.map(t => `${t.name || ''} ${t.context || ''}`) : []),
    ...(Array.isArray(signal.files_modified) ? signal.files_modified : []),
  ].join('\n').toLowerCase();

  const scored = allInsights
    .map((insight) => {
      const tokens = extractInsightTokens(insight).slice(0, 12);
      if (tokens.length === 0) return { insight, score: 0 };
      let score = 0;
      for (const token of tokens) {
        if (context.includes(token)) score++;
      }
      return { insight, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) return scored.slice(0, 3).map(x => x.insight);
  return allInsights.length === 1 ? [allInsights[0]] : [];
}

function trackInsightOutcome(skillDir, isSuccess, signal = null) {
  const evoPath = path.join(skillDir, 'evolution.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(evoPath, 'utf8')); } catch { return; }

  if (!data.insights_stats) data.insights_stats = {};
  const now = new Date().toISOString();
  const allInsights = [
    ...(data.preferences || []),
    ...(data.fixes || []),
    ...(data.contexts || []),
  ];
  const targetInsights = signal ? pickMatchedInsights(allInsights, signal) : allInsights;

  for (const insight of targetInsights) {
    if (!data.insights_stats[insight]) {
      data.insights_stats[insight] = { success_count: 0, fail_count: 0, last_applied_at: null };
    }
    const stat = data.insights_stats[insight];
    if (isSuccess) stat.success_count++;
    else stat.fail_count++;
    stat.last_applied_at = now;
  }

  try { fs.writeFileSync(evoPath, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// ─────────────────────────────────────────────
// Cold Path: Haiku-Powered Analysis
// (called by heartbeat script task: skill-evolve)
// ─────────────────────────────────────────────

/**
 * Batch-analyze accumulated skill signals via Haiku.
 * All params come from evolution_policy.yaml — including the prompt itself.
 * Every N runs, triggers self-evaluation to optimize the policy.
 * Returns { updates, missing_skills } or null if nothing to process.
 */
const { callHaiku, buildDistillEnv } = require('./providers');

async function distillSkills() {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return null; }

  const policy = loadPolicy();

  // Read signals
  if (!fs.existsSync(SKILL_SIGNAL_FILE)) return null;
  const content = fs.readFileSync(SKILL_SIGNAL_FILE, 'utf8').trim();
  if (!content) return null;

  const lines = content.split('\n');
  const signals = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (signals.length < policy.min_signals_for_distill) return null;

  // Get installed skills list
  const installedSkills = listInstalledSkills();
  if (installedSkills.length === 0) {
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

  // Build prompt from policy template (all params injectable)
  const installedSkillsStr = installedSkills.map(s => `- ${s.name}: ${s.description || 'no description'}`).join('\n');
  const prompt = policy.prompt_template
    .replace(/\$\{installedSkills\}/g, installedSkillsStr)
    .replace(/\$\{signalCount\}/g, String(signals.length))
    .replace(/\$\{signalSummary\}/g, signalSummary)
    .replace(/\$\{patternContext\}/g, patternContext)
    .replace(/\$\{minEvidenceForUpdate\}/g, String(policy.min_evidence_for_update))
    .replace(/\$\{minEvidenceForGap\}/g, String(policy.min_evidence_for_gap))
    .replace(/\$\{maxUpdates\}/g, String(policy.max_updates_per_analysis))
    .replace(/\$\{maxGaps\}/g, String(policy.max_gaps_per_analysis));

  try {
    let distillEnv = {};
    try { distillEnv = buildDistillEnv(); } catch {}

    const result = await callHaiku(prompt, distillEnv, 90000);

    if (result.includes('NO_EVOLUTION')) {
      // Run workflow discovery before clearing signals
      try { await discoverWorkflows(signals, distillEnv); } catch {}
      clearSignals();
      bumpRunCount(yaml, policy);
      return { updates: [], missing_skills: [] };
    }

    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) {
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

    // Log this run for self-evaluation
    logEvolutionRun(yaml, policy, signals.length, updates.length, missingSkills.length);

    // Run workflow discovery before clearing signals
    try { await discoverWorkflows(signals, distillEnv); } catch {}

    clearSignals();

    // Self-evaluation: periodically let Haiku review and rewrite the policy
    bumpRunCount(yaml, policy);
    if (policy.cold_path_run_count > 0 && policy.cold_path_run_count % policy.self_eval_interval === 0) {
      await selfEvaluatePolicy(yaml, policy, distillEnv);
    }

    return { updates, missing_skills: missingSkills };

  } catch (err) {
    try { console.log(`⚠️ Skill evolution analysis failed: ${err.message}`); } catch {}
    return null;
  }
}

/**
 * Increment cold-path run counter in policy.
 */
function bumpRunCount(yaml, policy) {
  policy.cold_path_run_count = (policy.cold_path_run_count || 0) + 1;
  savePolicy(yaml, policy);
}

/**
 * Log each evolution run for self-evaluation audit trail.
 */
function logEvolutionRun(yaml, policy, signalCount, updateCount, gapCount) {
  const logFile = path.join(METAME_DIR, 'evolution_log.yaml');
  let log = { runs: [] };
  try {
    if (fs.existsSync(logFile)) log = yaml.load(fs.readFileSync(logFile, 'utf8')) || { runs: [] };
  } catch {}

  log.runs.push({
    ts: new Date().toISOString(),
    signals: signalCount,
    updates: updateCount,
    gaps: gapCount,
    policy_version: policy.version,
  });

  // Keep last 50 runs
  if (log.runs.length > 50) log.runs = log.runs.slice(-50);
  try { fs.writeFileSync(logFile, yaml.dump(log, { lineWidth: -1 }), 'utf8'); } catch {}
}

/**
 * Self-evaluation: Haiku reviews the evolution_log and current policy,
 * then rewrites evolution_policy.yaml if improvements are warranted.
 * This is how the system optimizes its own parameters.
 */
async function selfEvaluatePolicy(yaml, policy, distillEnv) {
  try {
    // Read evolution log
    const logFile = path.join(METAME_DIR, 'evolution_log.yaml');
    if (!fs.existsSync(logFile)) return;
    const log = yaml.load(fs.readFileSync(logFile, 'utf8'));
    if (!log?.runs || log.runs.length < 3) return;

    const recentRuns = log.runs.slice(-10);
    const runSummary = recentRuns.map(r =>
      `${r.ts}: ${r.signals} signals → ${r.updates} updates, ${r.gaps} gaps (policy v${r.policy_version})`
    ).join('\n');

    // Read queue effectiveness
    const queue = loadEvolutionQueue(yaml);
    const totalNotified = (queue.items || []).filter(i => i.status === 'notified').length;
    const totalInstalled = (queue.items || []).filter(i => i.status === 'installed').length;
    const totalDismissed = (queue.items || []).filter(i => i.status === 'dismissed').length;

    const evalPrompt = `You are a meta-optimization system. Your job is to evaluate and improve the skill evolution policy for an AI assistant called MetaMe.

CURRENT POLICY:
${yaml.dump(policy, { lineWidth: 120 })}

RECENT EVOLUTION RUNS (last ${recentRuns.length}):
${runSummary}

QUEUE STATS: ${totalNotified} notified, ${totalInstalled} installed by user, ${totalDismissed} dismissed by user

EVALUATE:
1. Are the thresholds appropriate? (too sensitive = noise, too strict = misses real issues)
2. Is the prompt_template effective? (are runs producing useful updates, or mostly NO_EVOLUTION?)
3. Are complaint_patterns and missing_skill_patterns catching real issues?
4. Should self_eval_interval be adjusted?

If the policy is working well, respond with exactly: NO_CHANGE

If improvements are needed, respond with a YAML code block containing ONLY the fields that should change:
\`\`\`yaml
# Only include fields that need changing
hot_failure_threshold: 4
min_signals_for_distill: 5
version: ${(policy.version || 1) + 1}
\`\`\`

RULES:
- Increment version when making changes
- Never remove fields, only modify values
- Be conservative: only change what the data clearly supports
- prompt_template changes should be surgical, not full rewrites`;

    const result = await callHaiku(evalPrompt, distillEnv, 30000);

    if (result.includes('NO_CHANGE')) {
      console.log('🧬 Policy self-eval: no changes needed.');
      return;
    }

    const yamlMatch = result.match(/```yaml\s*([\s\S]*?)```/);
    if (!yamlMatch) return;

    const patchData = yaml.load(yamlMatch[1]);
    if (!patchData || typeof patchData !== 'object') return;

    // Apply patch with schema/type sanitization.
    const newPolicy = sanitizePolicy({ ...policy, ...patchData });
    if (newPolicy.version <= policy.version) {
      newPolicy.version = policy.version + 1;
    }
    if (JSON.stringify(newPolicy) === JSON.stringify(policy)) {
      console.log('🧬 Policy self-eval: patch produced no effective change.');
      return;
    }
    savePolicy(yaml, newPolicy);
    console.log(`🧬 Policy self-evolved: v${policy.version} → v${newPolicy.version}`);

  } catch (err) {
    try { console.log(`⚠️ Policy self-eval failed (non-fatal): ${err.message}`); } catch {}
  }
}

// ─────────────────────────────────────────────
// Workflow Discovery (Cold Path extension)
// ─────────────────────────────────────────────

function loadWorkflowSketches(yaml) {
  try {
    if (!fs.existsSync(WORKFLOW_SKETCHES_FILE)) return { version: 1, last_updated: null, sketches: [] };
    const content = fs.readFileSync(WORKFLOW_SKETCHES_FILE, 'utf8');
    const data = yaml.load(content) || {};
    return {
      version: data.version || 1,
      last_updated: data.last_updated || null,
      sketches: Array.isArray(data.sketches) ? data.sketches : [],
    };
  } catch {
    return { version: 1, last_updated: null, sketches: [] };
  }
}

function saveWorkflowSketches(yaml, data) {
  try {
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(WORKFLOW_SKETCHES_FILE, yaml.dump(data, { lineWidth: -1 }), 'utf8');
  } catch {}
}

/**
 * Merge Haiku-clustered results back into persisted sketches.
 * - Existing IDs: increment count, append examples, update last_seen/confidence
 * - New IDs (null): generate ID, add to sketches (respecting max cap)
 * Returns merged sketches array.
 */
function mergeWorkflowSketches(existing, clustered, maxSketches) {
  const sketchMap = new Map();
  for (const s of existing) sketchMap.set(s.id, { ...s });

  const now = new Date().toISOString();

  for (const c of clustered) {
    if (c.id && sketchMap.has(c.id)) {
      // Update existing sketch
      const s = sketchMap.get(c.id);
      s.occurrence_count = (s.occurrence_count || 0) + 1;
      s.last_seen = now;
      if (c.confidence != null) s.confidence = c.confidence;
      // Append new example prompts (dedup, cap at 5)
      const exSet = new Set(s.example_prompts || []);
      for (const ex of (c.example_prompts || [])) {
        if (!exSet.has(ex) && exSet.size < 5) exSet.add(ex);
      }
      s.example_prompts = [...exSet];
    } else {
      // New sketch
      const newId = `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sketchMap.set(newId, {
        id: newId,
        pattern: c.pattern || 'unknown',
        tools_signature: c.tools_signature || [],
        example_prompts: (c.example_prompts || []).slice(0, 5),
        occurrence_count: c.occurrence_count || 1,
        first_seen: now,
        last_seen: now,
        confidence: c.confidence || 0.5,
        proposed: false,
      });
    }
  }

  // Enforce max sketches: keep most recently seen
  let sketches = [...sketchMap.values()];
  if (sketches.length > maxSketches) {
    sketches.sort((a, b) => new Date(b.last_seen || 0).getTime() - new Date(a.last_seen || 0).getTime());
    sketches = sketches.slice(0, maxSketches);
  }

  return sketches;
}

/**
 * Analyze workflow_candidate signals, cluster via Haiku, persist sketches,
 * and promote mature sketches to evolution_queue as workflow_proposal.
 */
async function discoverWorkflows(signals, distillEnv) {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return; }

  const policy = loadPolicy();

  // Only run every N cold-path cycles
  if ((policy.cold_path_run_count || 0) % policy.workflow_discovery_interval !== 0) return;

  // Filter workflow candidates
  const wfSignals = signals.filter(s => s.workflow_candidate);
  if (wfSignals.length < policy.min_signals_for_workflow) return;

  const sketchData = loadWorkflowSketches(yaml);

  // Build known sketches text for Haiku
  const knownSketches = sketchData.sketches.length > 0
    ? sketchData.sketches.map(s =>
      `- id: "${s.id}" pattern: "${s.pattern}" tools: [${(s.tools_signature || []).join(',')}] count: ${s.occurrence_count}`
    ).join('\n')
    : '(none)';

  // Build signals text
  const workflowSignals = wfSignals.map((s, i) => {
    const toolNames = (s.tools_used || []).map(t => t.name).filter(Boolean);
    return `${i + 1}. prompt="${(s.prompt || '').substring(0, 120)}" tools=[${toolNames.join(',')}]`;
  }).join('\n');

  const prompt = policy.workflow_prompt_template
    .replace(/\$\{knownSketches\}/g, knownSketches)
    .replace(/\$\{workflowSignals\}/g, workflowSignals);

  try {
    const result = await callHaiku(prompt, distillEnv, 60000);

    if (result.includes('NO_WORKFLOWS')) return;

    const jsonMatch = result.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) return;

    const clustered = JSON.parse(jsonMatch[1]);
    if (!Array.isArray(clustered) || clustered.length === 0) return;

    // Merge into persisted sketches
    sketchData.sketches = mergeWorkflowSketches(sketchData.sketches, clustered, policy.workflow_max_sketches);

    // Purge stale sketches (not seen within workflow_stale_days, not proposed)
    const staleCutoff = Date.now() - policy.workflow_stale_days * 24 * 60 * 60 * 1000;
    const veryOldCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    sketchData.sketches = sketchData.sketches.filter(s => {
      const lastSeenMs = new Date(s.last_seen || s.first_seen || 0).getTime();
      if (s.proposed) return true; // keep proposed until dismissed
      if (lastSeenMs <= veryOldCutoff) return false; // 90 days hard cap
      return lastSeenMs > staleCutoff || (s.occurrence_count || 0) >= 2;
    });

    // Promote mature sketches to evolution queue
    const queue = loadEvolutionQueue(yaml);
    for (const sketch of sketchData.sketches) {
      if (sketch.proposed) continue;
      if ((sketch.occurrence_count || 0) >= policy.workflow_proposal_threshold &&
          (sketch.confidence || 0) >= policy.workflow_min_confidence) {
        addToQueue(queue, {
          type: 'workflow_proposal',
          skill_name: null,
          reason: `检测到重复工作流: ${sketch.pattern}`,
          search_hint: sketch.pattern,
          evidence_count: sketch.occurrence_count,
          workflow_sketch_id: sketch.id,
          example_prompt: (sketch.example_prompts || [])[0] || '',
          tools_signature: sketch.tools_signature || [],
        });
        sketch.proposed = true;
      }
    }
    saveEvolutionQueue(yaml, queue);
    saveWorkflowSketches(yaml, sketchData);

  } catch (err) {
    try { console.log(`⚠️ Workflow discovery failed (non-fatal): ${err.message}`); } catch {}
  }
}

/**
 * Reset a workflow sketch after user dismisses a proposal.
 * Clears proposed flag and occurrence_count so it can re-accumulate.
 */
function resetWorkflowSketch(sketchId) {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return false; }

  const data = loadWorkflowSketches(yaml);
  const sketch = data.sketches.find(s => s.id === sketchId);
  if (!sketch) return false;

  sketch.proposed = false;
  sketch.occurrence_count = 0;
  sketch.example_prompts = [];
  saveWorkflowSketches(yaml, data);
  return true;
}

// ─────────────────────────────────────────────
// Evolution Queue Management
// ─────────────────────────────────────────────

function loadEvolutionQueue(yaml) {
  try {
    if (!fs.existsSync(EVOLUTION_QUEUE_FILE)) return { items: [] };
    const content = fs.readFileSync(EVOLUTION_QUEUE_FILE, 'utf8');
    const data = yaml.load(content);
    const queue = data && Array.isArray(data.items) ? data : { items: [] };
    let changed = false;
    for (const item of queue.items) {
      if (!item.id) {
        item.id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        changed = true;
      }
    }
    if (changed) saveEvolutionQueue(yaml, queue);
    return queue;
  } catch {
    return { items: [] };
  }
}

function saveEvolutionQueue(yaml, queue) {
  try {
    fs.writeFileSync(EVOLUTION_QUEUE_FILE, yaml.dump(queue, { lineWidth: -1 }), 'utf8');
  } catch {}
}

// Per-type dedup field: type → function(queueItem, newEntry) → bool
// Add a new entry here whenever a new queue type with its own dedup key is introduced.
const QUEUE_DEDUP_MATCH = {
  skill_gap:         (i, e) => (i.search_hint || '') === (e.search_hint || ''),
  workflow_proposal: (i, e) => (i.workflow_sketch_id || '') === (e.workflow_sketch_id || ''),
};

function addToQueue(queue, entry) {
  // Dedup pending entries by core key, with per-type extra field matching.
  const dedupFn = QUEUE_DEDUP_MATCH[entry.type];
  const existing = queue.items.find(i =>
    i.type === entry.type &&
    i.skill_name === entry.skill_name &&
    i.status === 'pending' &&
    (!dedupFn || dedupFn(i, entry))
  );

  if (existing) {
    existing.evidence_count = (existing.evidence_count || 0) + (entry.evidence_count || 1);
    existing.last_seen = new Date().toISOString();
    if (entry.reason) existing.reason = entry.reason;
    if (entry.search_hint) existing.search_hint = entry.search_hint;
    return;
  }

  queue.items.push({
    id: `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
  const notifications = [];
  const policy = loadPolicy();

  for (const item of pendingItems) {
    // Require minimum evidence before notifying
    const minEvidence = item.type === 'skill_gap' ? policy.min_evidence_for_gap : policy.min_evidence_for_update;
    if ((item.evidence_count || 1) < minEvidence) continue;

    item.status = 'notified';
    item.notified_at = new Date().toISOString();
    notifications.push(item);
  }

  // Prune old resolved items (> 30 days)
  const beforeLen = queue.items.length;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  queue.items = queue.items.filter(i =>
    i.status === 'pending' || i.status === 'notified' ||
    (new Date(i.last_seen || i.detected).getTime() > cutoff)
  );

  if (notifications.length > 0 || queue.items.length !== beforeLen) {
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
    appendChange('queue_resolved', skillName || item.search_hint || 'unknown', `${type} → ${resolution}`);
  }
}

/**
 * Mark queue item resolved by queue id.
 * Returns true when updated.
 */
function resolveQueueItemById(id, resolution) {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return false; }
  if (!id) return false;

  const queue = loadEvolutionQueue(yaml);
  const item = queue.items.find(i =>
    i.id === id && (i.status === 'pending' || i.status === 'notified')
  );
  if (!item) return false;

  item.status = resolution; // 'installed' | 'dismissed'
  item.resolved_at = new Date().toISOString();
  saveEvolutionQueue(yaml, queue);
  return true;
}

/**
 * List queue items for manual triage.
 */
function listQueueItems({ status = null, limit = 20 } = {}) {
  let yaml;
  try { yaml = require('js-yaml'); } catch { return []; }
  const queue = loadEvolutionQueue(yaml);
  const items = Array.isArray(queue.items) ? queue.items : [];
  // status can be a single string or an array of strings
  const statuses = Array.isArray(status) ? status : (status ? [status] : null);
  const filtered = statuses ? items.filter(i => statuses.includes(i.status)) : items;
  return filtered
    .slice()
    .sort((a, b) => new Date(b.last_seen || b.detected || 0).getTime() - new Date(a.last_seen || a.detected || 0).getTime())
    .slice(0, Math.max(1, limit));
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

  // Log to changelog
  const skillName = path.basename(skillDir);
  const added = [];
  for (const key of ['preferences', 'fixes', 'contexts']) {
    if (newData[key] && newData[key].length) added.push(`+${newData[key].length} ${key}`);
  }
  if (added.length > 0) {
    appendChange('evolved', skillName, added.join(', '), (newData.fixes || newData.preferences || newData.contexts || [])[0]);
  }
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
  const AUTO_START = '<!-- METAME-EVOLUTION:START -->';
  const AUTO_END = '<!-- METAME-EVOLUTION:END -->';
  const sections = [];
  sections.push(`\n\n${AUTO_START}`);
  sections.push('\n## User-Learned Best Practices & Constraints');
  sections.push('\n> **Auto-Generated Section**: Maintained by skill-evolution-manager. Do not edit manually.');

  // Helper: get quality indicator for an insight based on stats
  const getQualityTag = (insight) => {
    const stat = data.insights_stats?.[insight];
    if (!stat || stat.success_count + stat.fail_count < 3) return ''; // insufficient data
    const total = stat.success_count + stat.fail_count;
    const failRate = stat.fail_count / total;
    if (failRate > 0.6) return ' ⚠️'; // >60% fail rate
    return '';
  };

  if (data.preferences?.length) {
    sections.push('\n### User Preferences');
    for (const item of data.preferences) sections.push(`- ${item}${getQualityTag(item)}`);
  }

  if (data.fixes?.length) {
    sections.push('\n### Known Fixes & Workarounds');
    for (const item of data.fixes) sections.push(`- ${item}${getQualityTag(item)}`);
  }

  if (data.custom_prompts) {
    sections.push('\n### Custom Instruction Injection');
    sections.push(`\n${data.custom_prompts}`);
  }

  sections.push(`\n${AUTO_END}\n`);
  const evolutionBlock = sections.join('\n');

  let content = fs.readFileSync(skillMdPath, 'utf8');
  const markerPattern = new RegExp(`${AUTO_START}[\\s\\S]*?${AUTO_END}\\n?`);
  const legacyPattern = /\n+## User-Learned Best Practices & Constraints[\s\S]*?(?=\n##\s+|\n#\s+|$)/;

  if (markerPattern.test(content)) {
    content = content.replace(markerPattern, evolutionBlock.trimStart());
  } else if (legacyPattern.test(content)) {
    content = content.replace(legacyPattern, evolutionBlock);
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
  try {
    const locked = withSkillSignalLock(() => writeSkillSignalLines([]));
    if (!locked) fs.writeFileSync(SKILL_SIGNAL_FILE, '', 'utf8');
  } catch {}
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
  discoverWorkflows,
  resetWorkflowSketch,
  checkEvolutionQueue,
  resolveQueueItem,
  resolveQueueItemById,
  listQueueItems,
  mergeEvolution,
  smartStitch,
  trackInsightOutcome,
  listInstalledSkills,
};

if (require.main === module) {
  distillSkills()
    .then(r => {
      if (r && r.updates && r.updates.length) {
        console.log(`Skill evolution: ${r.updates.length} update(s) applied`);
      } else {
        console.log('Skill evolution: no updates');
      }
    })
    .catch(e => {
      console.error('Skill evolution error:', e.message);
      process.exit(1);
    });
}

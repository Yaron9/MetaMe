#!/usr/bin/env node

/**
 * MetaMe Passive Distiller
 *
 * Reads raw signal buffer, calls Claude (configured distill model, non-interactive)
 * to extract persistent preferences/identity, merges into profile.
 *
 * Runs automatically before each MetaMe session launch.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { callHaiku, buildDistillEnv } = require('./providers');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const BUFFER_FILE = path.join(HOME, '.metame', 'raw_signals.jsonl');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');
const LOCK_FILE = path.join(HOME, '.metame', 'distill.lock');
const MEMORY_DIR = path.join(METAME_DIR, 'memory');
const POSTMORTEM_DIR = path.join(MEMORY_DIR, 'postmortems');

const { hasKey, isLocked, getTier, getDefinition, getWritableKeysForPrompt, estimateTokens, TOKEN_BUDGET } = require('./schema');
const { loadPending, savePending, upsertPending, getPromotable, removePromoted, expireStale } = require('./pending-traits');
const { writeBrainFileSafe, normalizeProjectPath, deriveProjectInfo } = require('./utils');

// Session analytics — local skeleton extraction (zero API cost)
let sessionAnalytics = null;
try {
  sessionAnalytics = require('./session-analytics');
} catch (e) {
  console.log(`[distill] session-analytics unavailable: ${e.message} — behavior extraction disabled`);
}

// Provider env for distillation (cheap relay for background tasks)
let distillEnv = {};
try {
  distillEnv = buildDistillEnv();
} catch { /* providers not configured — use defaults */ }

const COMPETENCE_SCORE = {
  beginner: 1,
  intermediate: 2,
  expert: 3,
};

function normalizeCompetenceLevel(level) {
  const v = String(level || '').trim().toLowerCase();
  if (v === 'beginner' || v === 'intermediate' || v === 'expert') return v;
  return null;
}

function normalizeDomainName(domain) {
  const raw = String(domain || '').trim();
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').slice(0, 40);
}

function mergeCompetenceMap(currentMap, competenceSignals) {
  const next = {
    ...(currentMap && typeof currentMap === 'object' && !Array.isArray(currentMap) ? currentMap : {}),
  };
  const signals = Array.isArray(competenceSignals) ? competenceSignals : [];
  let changed = false;

  for (const signal of signals) {
    const domain = normalizeDomainName(signal && signal.domain);
    const level = normalizeCompetenceLevel(signal && signal.level);
    if (!domain || !level) continue;

    const oldLevel = normalizeCompetenceLevel(next[domain]);
    if (!oldLevel) {
      next[domain] = level;
      changed = true;
      continue;
    }

    const oldScore = COMPETENCE_SCORE[oldLevel] || 0;
    const newScore = COMPETENCE_SCORE[level] || 0;
    if (newScore >= oldScore) {
      if (newScore > oldScore) {
        next[domain] = level;
        changed = true;
      }
      continue;
    }

    // Downgrade is only allowed with explicit downgrade evidence.
    const downgradeEvidence = String(signal && signal.downgrade_evidence ? signal.downgrade_evidence : '').trim();
    if (downgradeEvidence) {
      next[domain] = level;
      changed = true;
    }
  }

  const entries = Object.entries(next);
  if (entries.length <= 20) return { map: next, changed };

  // Keep top-20 by level score to avoid unbounded growth.
  entries.sort((a, b) => (COMPETENCE_SCORE[b[1]] || 0) - (COMPETENCE_SCORE[a[1]] || 0));
  const compact = Object.fromEntries(entries.slice(0, 20));
  return { map: compact, changed: true };
}

function sanitizeSlug(input, fallback = 'session') {
  const v = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!v) return fallback;
  return v.slice(0, 48);
}

function stripMd(text) {
  return String(text || '').replace(/[#*_`>\[\]\(\)]/g, ' ').replace(/\s+/g, ' ').trim();
}

function appendPostmortemSkillSignal(skillName, skeleton, reasons, filePath) {
  let skillEvolution = null;
  try { skillEvolution = require('./skill-evolution'); } catch { /* optional */ }
  if (!skillEvolution || typeof skillEvolution.appendSkillSignal !== 'function') return;
  const name = String(skillName || '').trim();
  if (!name) return;
  try {
    skillEvolution.appendSkillSignal({
      ts: new Date().toISOString(),
      type: 'postmortem_lesson',
      prompt: skeleton && skeleton.intent ? skeleton.intent : '',
      output: `postmortem:${name}`,
      error: null,
      skills_invoked: [name],
      has_tool_failure: Number(skeleton && skeleton.tool_error_count) > 0,
      tool_usage: [],
      files_modified: [],
      cwd: skeleton && skeleton.project_path ? skeleton.project_path : '',
      metadata: {
        source: 'distill-postmortem',
        reasons,
        postmortem_file: filePath,
      },
    });
  } catch { /* non-fatal */ }
}

async function maybeGeneratePostmortemArtifact(skeleton, sessionPath) {
  if (!sessionAnalytics || !skeleton || !sessionPath) return null;
  const detector = sessionAnalytics.detectSignificantSession;
  if (typeof detector !== 'function') return null;

  const sig = detector(skeleton);
  if (!sig || !sig.significant) return null;

  let evidence = null;
  try {
    if (typeof sessionAnalytics.extractEvidence === 'function') {
      evidence = sessionAnalytics.extractEvidence(sessionPath, 3200);
    }
  } catch { /* non-fatal */ }

  const promptInput = JSON.stringify({
    skeleton: {
      session_id: skeleton.session_id,
      duration_min: skeleton.duration_min,
      tool_error_count: skeleton.tool_error_count,
      retry_sequences: skeleton.retry_sequences,
      git_diff_lines: skeleton.git_diff_lines,
      error_recovered: skeleton.error_recovered,
      intent: skeleton.intent,
      project: skeleton.project,
      project_id: skeleton.project_id,
    },
    reasons: sig.reasons,
    evidence,
  }, null, 2).slice(0, 5200);

  const pmPrompt = `你是工程复盘助手。根据会话骨架和证据生成一份简洁 postmortem。

输入(JSON):
${promptInput}

输出 JSON：
{
  "title":"简短标题",
  "problem":"遇到的问题（1句）",
  "root_cause":"根因（1句）",
  "fix":"修复方案（1句）",
  "lesson":"可复用教训（1句）",
  "skill":"可选，若明显涉及某技能则写 skill 名，否则空字符串"
}

规则：
- 只基于输入，不要虚构
- 每个字段 20-180 字
- 只输出 JSON`;

  let raw = '';
  try {
    raw = await callHaiku(pmPrompt, distillEnv, 60000);
  } catch {
    return null;
  }

  let parsed = null;
  try {
    const cleaned = String(raw).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  const title = String(parsed && parsed.title ? parsed.title : '').trim();
  const problem = String(parsed && parsed.problem ? parsed.problem : '').trim();
  const rootCause = String(parsed && parsed.root_cause ? parsed.root_cause : '').trim();
  const fix = String(parsed && parsed.fix ? parsed.fix : '').trim();
  const lesson = String(parsed && parsed.lesson ? parsed.lesson : '').trim();
  if (!title || !problem || !rootCause || !fix || !lesson) return null;

  fs.mkdirSync(POSTMORTEM_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const topicSlug = sanitizeSlug(skeleton.intent || title, `session-${String(skeleton.session_id || '').slice(0, 8)}`);
  const filePath = path.join(POSTMORTEM_DIR, `${day}-${topicSlug}.md`);
  const markdown = [
    `# ${title}`,
    '',
    `- date: ${day}`,
    `- session_id: ${skeleton.session_id || 'unknown'}`,
    `- project: ${skeleton.project || 'unknown'}`,
    `- project_id: ${skeleton.project_id || 'unknown'}`,
    `- reasons: ${(sig.reasons || []).join(', ') || 'n/a'}`,
    '',
    '## 问题',
    problem,
    '',
    '## 根因',
    rootCause,
    '',
    '## 解法',
    fix,
    '',
    '## 教训',
    lesson,
    '',
  ].join('\n');
  fs.writeFileSync(filePath, markdown, 'utf8');

  let memory = null;
  try {
    memory = require('./memory');
  } catch { /* optional */ }

  if (memory && typeof memory.saveFacts === 'function') {
    const value = stripMd(`问题:${problem} 根因:${rootCause} 解法:${fix} 教训:${lesson}`).slice(0, 280);
    if (value.length >= 20) {
      const entityProject = sanitizeSlug(skeleton.project || 'unknown', 'unknown');
      const fallbackScope = skeleton.session_id
        ? `sess_${String(skeleton.session_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`
        : null;
      try {
        memory.saveFacts(
          skeleton.session_id || `pm-${Date.now()}`,
          skeleton.project || 'unknown',
          [{
            entity: `postmortem.${entityProject}`,
            relation: 'bug_lesson',
            value,
            confidence: 'high',
            tags: ['postmortem'],
          }],
          { scope: skeleton.project_id || fallbackScope }
        );
      } catch { /* non-fatal */ }
    }
    try { memory.close(); } catch { /* non-fatal */ }
  }

  appendPostmortemSkillSignal(parsed && parsed.skill, skeleton, sig.reasons || [], filePath);

  return { file: filePath, reasons: sig.reasons || [] };
}

function selectSignalBatch(lines) {
  const parsed = [];
  for (const rawLine of lines) {
    try {
      const entry = JSON.parse(rawLine);
      if (entry && typeof entry === 'object') parsed.push({ rawLine, entry });
    } catch {
      // Drop malformed lines; they are non-recoverable noise.
    }
  }

  if (parsed.length === 0) {
    return {
      batchEntries: [],
      remainingLines: [],
      anchorSessionId: null,
      anchorCwd: null,
    };
  }

  let anchorSessionId = null;
  let anchorCwd = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const e = parsed[i].entry;
    if (!e) continue;
    if (e.session) anchorSessionId = String(e.session);
    if (e.cwd) anchorCwd = e.cwd;
    if (anchorSessionId || anchorCwd) break;
  }
  const normalizedAnchorCwd = normalizeProjectPath(anchorCwd);

  const batchEntries = [];
  const remainingLines = [];
  for (const row of parsed) {
    const e = row.entry;
    const rowSessionId = e.session ? String(e.session) : null;
    const rowCwd = normalizeProjectPath(e.cwd);

    let inBatch = true;
    if (anchorSessionId) {
      // Primary binding by session id; fallback to cwd for legacy signals without session.
      inBatch = rowSessionId === anchorSessionId || (!rowSessionId && !!normalizedAnchorCwd && rowCwd === normalizedAnchorCwd);
    } else if (normalizedAnchorCwd) {
      inBatch = rowCwd === normalizedAnchorCwd;
    }

    if (inBatch) batchEntries.push(e);
    else remainingLines.push(row.rawLine);
  }

  return {
    batchEntries,
    remainingLines,
    anchorSessionId,
    anchorCwd: normalizedAnchorCwd,
  };
}

/**
 * Main distillation process.
 * Returns { updated: boolean, summary: string }
 */
async function distill() {
  // 1. Check if buffer exists and has content
  if (!fs.existsSync(BUFFER_FILE)) {
    return { updated: false, behavior: null, summary: 'No signals to process.' };
  }

  const raw = fs.readFileSync(BUFFER_FILE, 'utf8').trim();
  if (!raw) {
    return { updated: false, behavior: null, summary: 'Empty buffer.' };
  }

  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { updated: false, behavior: null, summary: 'No signals to process.' };
  }

  // 2. Prevent concurrent distillation (atomic lock via O_EXCL)
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(lockFd, process.pid.toString());
    fs.closeSync(lockFd);
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Another process holds the lock — check if stale
      try {
        const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (lockAge < 120000) {
          return { updated: false, behavior: null, summary: 'Distillation already in progress.' };
        }
        fs.unlinkSync(LOCK_FILE);
        // Retry once after removing stale lock
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(lockFd, process.pid.toString());
        fs.closeSync(lockFd);
      } catch {
        return { updated: false, behavior: null, summary: 'Distillation already in progress.' };
      }
    } else {
      throw e;
    }
  }

  let remainingSignalLines = lines;
  let ackSignals = false;
  const finalize = () => cleanup({ ack: ackSignals, remainingLines: remainingSignalLines });

  try {
    // 3. Parse signals (preserve confidence + type from signal-capture)
    const batch = selectSignalBatch(lines);
    remainingSignalLines = batch.remainingLines;
    const signalAnchorSessionId = batch.anchorSessionId;
    const signalProjectInfo = deriveProjectInfo(batch.anchorCwd);

    const signals = [];
    let highConfidenceCount = 0;
    for (const entry of batch.batchEntries) {
      try {
        if (entry.prompt) {
          signals.push({ text: entry.prompt, type: entry.type || 'implicit' });
          if (entry.confidence === 'high') highConfidenceCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (signals.length === 0) {
      ackSignals = true;
      finalize();
      return { updated: false, behavior: null, summary: 'No valid signals.' };
    }

    // 3b. Extract session skeleton (local, zero API cost)
    let sessionContext = '';
    let skeleton = null;
    let sessionSummary = null;
    let targetSessionPath = null;
    if (sessionAnalytics) {
      try {
        let targetSession = null;
        if (signalAnchorSessionId && typeof sessionAnalytics.findSessionById === 'function') {
          targetSession = sessionAnalytics.findSessionById(signalAnchorSessionId);
          if (!targetSession) {
            console.log(`[distill] signal session ${signalAnchorSessionId.slice(0, 8)} not found — skip session context to avoid cross-session mismatch`);
          }
        } else {
          targetSession = sessionAnalytics.findLatestUnanalyzedSession();
        }
        if (targetSession) {
          skeleton = sessionAnalytics.extractSkeleton(targetSession.path);
          targetSessionPath = targetSession.path;
          sessionContext = sessionAnalytics.formatForPrompt(skeleton);
          // For long sessions, extract pivot points
          sessionSummary = sessionAnalytics.summarizeSession(skeleton, targetSession.path);
        }
      } catch (e) {
        console.log(`[distill] session context extraction failed: ${e.message}`);
      }
    }

    // 3c. Recall relevant long-term facts as additional cognition context (read-only).
    let memorySection = '';
    try {
      const memory = require('./memory');
      const searchFn = memory.searchFactsAsync || memory.searchFacts;
      const signalTail = signals.slice(-6).map(s => s.text).join(' ').slice(0, 260);
      const outcomeHint = sessionSummary && sessionSummary.outcome ? ` outcome:${sessionSummary.outcome}` : '';
      const recallQuery = (signalTail + outcomeHint).trim();
      if (recallQuery) {
        const recallProject = (skeleton && skeleton.project) ? skeleton.project : signalProjectInfo.project;
        const recallScope = (skeleton && skeleton.project_id) ? skeleton.project_id : signalProjectInfo.project_id;
        const facts = await Promise.resolve(searchFn(recallQuery, {
          limit: 4,
          project: recallProject || undefined,
          scope: recallScope || undefined,
        }));
        if (facts && facts.length > 0) {
          const factLines = facts.map((f, i) => `${i + 1}. [${f.relation}] ${f.value}`).join('\n');
          memorySection = `\nRECALLED LONG-TERM FACTS (context only, do not restate verbatim):\n${factLines}\n`;
        }
      }
      memory.close();
    } catch { /* memory optional */ }

    // 4. Read current profile
    let currentProfile = '';
    try {
      currentProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    } catch {
      currentProfile = '(empty profile)';
    }

    // 5. Build distillation prompt (compact + session-aware)
    // Input budget: keep total prompt under INPUT_TOKEN_BUDGET to control cost/latency.
    // Priority: system prompt + profile + writable keys (must keep) > user messages > session context
    const INPUT_TOKEN_BUDGET = 4000; // ~12K chars mixed zh/en

    const writableKeys = getWritableKeysForPrompt();

    // Reserve budget for fixed parts (system prompt template ~600 tokens, profile, writable keys)
    const fixedOverhead = 600; // system prompt template + rules
    const profileTokens = estimateTokens(currentProfile);
    const keysTokens = estimateTokens(writableKeys);
    const reservedTokens = fixedOverhead + profileTokens + keysTokens;
    const availableForContent = Math.max(INPUT_TOKEN_BUDGET - reservedTokens, 200);

    // Build session context (lower priority — truncate first)
    let sessionSection = sessionContext
      ? `\nSESSION CONTEXT (what happened in the same session/cwd as current signals):\n${sessionContext}\n`
      : '';

    if (sessionSummary) {
      const pivotText = sessionSummary.pivots.length > 0
        ? `\nPivots: ${sessionSummary.pivots.join('; ')}`
        : '';
      sessionSection += `Summary: ${sessionSummary.intent} → ${sessionSummary.outcome}${pivotText}\n`;
    }

    let goalContext = '';
    if (sessionAnalytics) {
      try { goalContext = sessionAnalytics.formatGoalContext(BRAIN_FILE); } catch { }
    }
    let goalSection = goalContext ? `\n${goalContext}\n` : '';

    // Allocate remaining budget: user messages get priority.
    // Context priority when tight: memorySection -> sessionSection/goalSection -> user message trimming.
    const MEMORY_TOKEN_CAP = Math.max(120, Math.floor(availableForContent * 0.35));
    if (memorySection && estimateTokens(memorySection) > MEMORY_TOKEN_CAP) {
      let compactFacts = '';
      try {
        const lines = memorySection.split('\n').filter(Boolean).slice(0, 4);
        compactFacts = lines.join('\n').slice(0, 900);
      } catch { /* keep original if split fails */ }
      memorySection = compactFacts || memorySection.slice(0, 900);
    }

    let contextTokens = estimateTokens(sessionSection + goalSection + memorySection);
    let budgetForMessages = availableForContent - contextTokens;

    // If not enough room, drop memory context first, then session/goal, then trim messages.
    if (budgetForMessages < 100) {
      memorySection = '';
      contextTokens = estimateTokens(sessionSection + goalSection);
      budgetForMessages = availableForContent - contextTokens;
    }
    if (budgetForMessages < 100) {
      sessionSection = '';
      goalSection = '';
      budgetForMessages = availableForContent;
    }

    const HARD_SIGNAL_CHAR_CAP = 900;
    const clampSignalText = (text, maxChars = HARD_SIGNAL_CHAR_CAP) => {
      const s = String(text || '').trim();
      if (!s) return '';
      return s.length > maxChars ? s.slice(0, maxChars) : s;
    };

    // Format signals: tag metacognitive and correction signals so Haiku treats them differently
    const formatSignal = (s, i) => {
      const tag = s.type === 'metacognitive' ? ' [META]' : s.type === 'correction' ? ' [CORRECTION]' : '';
      return `${i + 1}. "${clampSignalText(s.text)}"${tag}`;
    };

    // Truncate user messages to fit budget (keep most recent, they're more relevant)
    let truncatedSignals = signals;
    let userMessages = signals.map(formatSignal).join('\n');
    if (estimateTokens(userMessages) > budgetForMessages) {
      // Drop oldest messages until we fit
      while (truncatedSignals.length > 1 && estimateTokens(
        truncatedSignals.map(formatSignal).join('\n')
      ) > budgetForMessages) {
        truncatedSignals = truncatedSignals.slice(1);
      }
      userMessages = truncatedSignals.map(formatSignal).join('\n');
    }

    // Hard fallback for single-oversized signal: always enforce budget even when only one message remains.
    if (estimateTokens(userMessages) > budgetForMessages && truncatedSignals.length > 0) {
      const last = truncatedSignals[truncatedSignals.length - 1];
      const dynamicCap = Math.max(120, Math.min(HARD_SIGNAL_CHAR_CAP, Math.floor(budgetForMessages * 3)));
      truncatedSignals = [{ ...last, text: clampSignalText(last.text, dynamicCap) }];
      userMessages = truncatedSignals.map(formatSignal).join('\n');
    }

    const distillPrompt = `You are a MetaMe cognitive profile distiller. Extract COGNITIVE TRAITS and PREFERENCES — how the user thinks, decides, and communicates. You are not a fact archiver.

CURRENT PROFILE:
\`\`\`yaml
${currentProfile}
\`\`\`

WRITABLE FIELDS (T1/T2 are LOCKED and omitted — you may ONLY output keys from this list):
${writableKeys}

RECENT USER MESSAGES:
${userMessages}
${sessionSection}${goalSection}${memorySection}
RULES:
1. Extract ONLY cognitive traits, preferences, behavioral patterns — NOT facts or events.
2. IGNORE task-specific messages. Only extract what persists across ALL sessions.
3. Only output fields from WRITABLE FIELDS. Any other key will be rejected.
4. For enum fields, use one of the listed values.
5. Strong directives (以后一律/always/never/from now on) → _confidence: high. Otherwise: normal.
6. Messages tagged [META] are metacognitive signals (self-reflection, strategy shifts, error awareness). These are HIGH VALUE for cognition fields — extract decision_style, error_response, receptive_to_challenge, and behavioral patterns from them.
7. Add _confidence and _source blocks mapping field keys to confidence level and triggering quote.
8. NEVER extract agent identity or role definitions. Messages like "你是贾维斯/你的角色是.../you are Jarvis" define the AGENT, not the USER. The profile is about the USER's cognition only.
9. Recalled long-term facts are context signals only. Use them to support/deny persistent cognition, never copy them as factual output.

BIAS PREVENTION:
- Single observation = STATE, not TRAIT. T3 cognition needs 3+ observations.
- L1 Surface → needs 5+, L2 Behavior → needs 3, L3 Self-declaration → direct write.
- Contradiction with existing value → do NOT output (needs accumulation).
- EXCEPTION: [CORRECTION] signals are explicit user corrections — they CAN and SHOULD overwrite contradicting existing values directly, with _confidence: high. The user is teaching us we were wrong.

BEHAVIORAL ANALYSIS — _behavior block (always output, use null if insufficient signal):
  decision_pattern: premature_closure | exploratory | iterative | null
  cognitive_load: low | medium | high | null
  zone: comfort | stretch | panic | null
  avoidance_topics: []
  emotional_response: analytical | blame_external | blame_self | withdrawal | null
  topics: []
  session_outcome: completed | abandoned | blocked | pivoted | null
  friction: []                   # max 3 keywords describing pain points
  goal_alignment: aligned | partial | drifted | null
  drift_note: "max 30 char explanation" or null
  competence_signals:            # optional, max 5
    - domain: "领域名"
      level: beginner | intermediate | expert
      evidence: "触发证据"
      downgrade_evidence: "只有在明确降级时填写，否则省略"
${sessionContext ? '\nHint: high tool_calls + routine messages → zone likely higher. If DECLARED_GOALS exist, assess goal_alignment.' : ''}
OUTPUT — respond with ONLY a YAML code block. If nothing worth saving AND no behavior: respond with exactly NO_UPDATE.
Do NOT repeat existing unchanged values.`;

    // 6. Call Claude in print mode with configured distill model (+ provider env for relay support)
    let result;
    try {
      result = await callHaiku(distillPrompt, distillEnv, 60000);
    } catch (err) {
      // Don't cleanup buffer on API failure — retry next launch
      try { fs.unlinkSync(LOCK_FILE); } catch { }
      const isTimeout = err.killed || (err.signal === 'SIGTERM');
      if (isTimeout) {
        return { updated: false, behavior: null, summary: 'Skipped — API too slow. Will retry next launch.' };
      }
      return { updated: false, behavior: null, summary: 'Skipped — Claude not available. Will retry next launch.' };
    }

    // 7. Parse result
    if (!result || result === 'NO_UPDATE') {
      if (skeleton && sessionAnalytics) {
        try { sessionAnalytics.markAnalyzed(skeleton.session_id); } catch { /* non-fatal */ }
      }
      ackSignals = true;
      finalize();
      let postmortem = null;
      try {
        postmortem = await maybeGeneratePostmortemArtifact(skeleton, targetSessionPath);
      } catch { /* non-fatal */ }
      return {
        updated: false,
        behavior: null,
        skeleton,
        postmortem,
        signalCount: signals.length,
        summary: `Analyzed ${signals.length} messages — no persistent insights found.`,
      };
    }

    // Extract YAML block from response — require explicit code block, no fallback
    const yamlMatch = result.match(/```yaml\n([\s\S]*?)```/) || result.match(/```\n([\s\S]*?)```/);
    if (!yamlMatch) {
      ackSignals = false;
      finalize();
      return { updated: false, behavior: null, summary: 'Distiller returned malformed output. Signals preserved for retry.' };
    }
    const yamlContent = yamlMatch[1].trim();

    if (!yamlContent) {
      ackSignals = false;
      finalize();
      return { updated: false, behavior: null, summary: 'Distiller returned empty result. Signals preserved for retry.' };
    }

    // 8. Validate against schema + merge into profile
    try {
      const yaml = require('js-yaml');
      const updates = yaml.load(yamlContent);
      if (!updates || typeof updates !== 'object') {
        ackSignals = false;
        finalize();
        return { updated: false, behavior: null, summary: 'Distiller returned invalid data. Signals preserved for retry.' };
      }

      // Extract _behavior block before filtering (it's not a profile field)
      const behavior = updates._behavior || null;
      delete updates._behavior;

      // Schema whitelist filter: drop any keys not in schema or locked
      const filtered = filterBySchema(updates);
      const extractedFieldCount = Object.keys(filtered).length;
      if (extractedFieldCount === 0 && !behavior) {
        ackSignals = true;
        finalize();
        return { updated: false, behavior: null, summary: `Analyzed ${signals.length} messages — all extracted fields rejected by schema.` };
      }

      const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

      // Read raw content to find locked lines and comments
      const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
      const lockedKeys = extractLockedKeys(rawProfile);
      const inlineComments = extractInlineComments(rawProfile);

      // Strategic merge: tier-aware upsert with pending traits
      const pendingTraits = loadPending();
      expireStale(pendingTraits); // remove observations not seen for >30 days
      const confidenceMap = updates._confidence || {};
      const sourceMap = updates._source || {};
      const merged = strategicMerge(profile, filtered, lockedKeys, pendingTraits, confidenceMap, sourceMap);
      savePending(pendingTraits);

      // Merge competence signals into user_competence_map (upgrade by default).
      const competenceSignals = Array.isArray(behavior && behavior.competence_signals)
        ? behavior.competence_signals
        : [];
      const mergedCompetence = mergeCompetenceMap(merged.user_competence_map, competenceSignals);
      if (mergedCompetence.changed) {
        merged.user_competence_map = mergedCompetence.map;
      }

      if (extractedFieldCount === 0 && !mergedCompetence.changed) {
        if (skeleton && sessionAnalytics) {
          try { sessionAnalytics.markAnalyzed(skeleton.session_id); } catch { }
        }
        ackSignals = true;
        finalize();
        let postmortem = null;
        try {
          postmortem = await maybeGeneratePostmortemArtifact(skeleton, targetSessionPath);
        } catch { /* non-fatal */ }
        return {
          updated: false,
          behavior,
          skeleton,
          postmortem,
          signalCount: signals.length,
          summary: `Analyzed ${signals.length} messages — behavior logged, no profile changes.`,
        };
      }

      // Add distillation log entry (keep last 10, compact format)
      if (!merged.evolution) merged.evolution = {};
      if (!merged.evolution.auto_distill) merged.evolution.auto_distill = [];
      const changedFields = Object.keys(filtered);
      if (mergedCompetence.changed) changedFields.push('user_competence_map');
      merged.evolution.auto_distill.push({
        ts: new Date().toISOString(),
        signals: signals.length,
        fields: changedFields.join(', ')
      });
      // Cap at 10 entries
      if (merged.evolution.auto_distill.length > 10) {
        merged.evolution.auto_distill = merged.evolution.auto_distill.slice(-10);
      }

      // Dump and restore comments (yaml.dump strips all comments)
      let dumped = yaml.dump(merged, { lineWidth: -1 });
      let restored = restoreComments(dumped, inlineComments);

      // A3: Token budget check — degrade gracefully if over budget
      let tokens = estimateTokens(restored);
      if (tokens > TOKEN_BUDGET) {
        // Step 1: Clear evolution.recent_changes
        if (merged.evolution.recent_changes) {
          merged.evolution.recent_changes = [];
        }
        dumped = yaml.dump(merged, { lineWidth: -1 });
        restored = restoreComments(dumped, inlineComments);
        tokens = estimateTokens(restored);
      }
      if (tokens > TOKEN_BUDGET) {
        // Step 2: Truncate all arrays to half
        truncateArrays(merged);
        dumped = yaml.dump(merged, { lineWidth: -1 });
        restored = restoreComments(dumped, inlineComments);
        tokens = estimateTokens(restored);
      }
      if (tokens > TOKEN_BUDGET) {
        // Step 3: Reject write entirely — emit alert so daemon can notify user
        const alertFile = path.join(HOME, '.metame', 'distill_alerts.jsonl');
        try {
          const alert = { ts: new Date().toISOString(), type: 'budget_exceeded', tokens, budget: TOKEN_BUDGET };
          fs.appendFileSync(alertFile, JSON.stringify(alert) + '\n', 'utf8');
        } catch { /* non-fatal */ }
        ackSignals = true;
        finalize();
        return { updated: false, behavior, signalCount: signals.length, summary: `Profile too large (${tokens} tokens > ${TOKEN_BUDGET}). Write rejected to prevent bloat.` };
      }

      await writeBrainFileSafe(restored, BRAIN_FILE);

      // Mark session as analyzed after successful distill
      if (skeleton && sessionAnalytics) {
        try { sessionAnalytics.markAnalyzed(skeleton.session_id); } catch { }
      }

      ackSignals = true;
      finalize();
      let postmortem = null;
      try {
        postmortem = await maybeGeneratePostmortemArtifact(skeleton, targetSessionPath);
      } catch { /* non-fatal */ }
      const absorbedCount = changedFields.length;
      return {
        updated: true,
        behavior,
        skeleton,
        sessionSummary,
        postmortem,
        signalCount: signals.length,
        summary: `${absorbedCount} new trait${absorbedCount > 1 ? 's' : ''} absorbed. (${tokens} tokens)`
      };

    } catch (err) {
      ackSignals = false;
      finalize();
      return { updated: false, behavior: null, summary: `Profile merge failed: ${err.message}. Signals preserved for retry.` };
    }

  } catch (err) {
    ackSignals = false;
    finalize();
    return { updated: false, behavior: null, summary: `Distillation error: ${err.message}. Signals preserved for retry.` };
  }
}

/**
 * Extract keys that are on lines marked with # [LOCKED]
 */
function extractLockedKeys(rawYaml) {
  const locked = new Set();
  const lines = rawYaml.split('\n');
  for (const line of lines) {
    if (line.includes('# [LOCKED]')) {
      const match = line.match(/^\s*([\w_]+)\s*:/);
      if (match) {
        locked.add(match[1]);
      }
    }
  }
  return locked;
}

/**
 * Extract inline comments from original YAML (key → comment mapping)
 * e.g. "  nickname: 3D # [LOCKED]" → { "nickname: 3D": "# [LOCKED]" }
 */
function extractInlineComments(rawYaml) {
  const comments = new Map();
  for (const line of rawYaml.split('\n')) {
    const commentMatch = line.match(/^(\s*[\w_]+\s*:.+?)\s+(#.+)$/);
    if (commentMatch) {
      // Key: the content part (trimmed), Value: the comment
      const content = commentMatch[1].trim();
      const comment = commentMatch[2];
      comments.set(content, comment);
    }
    // Also handle top-level keys with comments but no value on same line
    const keyCommentMatch = line.match(/^(\s*[\w_]+\s*:)\s+(#.+)$/);
    if (keyCommentMatch) {
      const content = keyCommentMatch[1].trim();
      const comment = keyCommentMatch[2];
      comments.set(content, comment);
    }
  }
  return comments;
}

/**
 * Restore inline comments to dumped YAML output
 */
function restoreComments(dumpedYaml, comments) {
  const lines = dumpedYaml.split('\n');
  const restored = lines.map(line => {
    const trimmed = line.trim();
    for (const [content, comment] of comments) {
      if (trimmed === content || trimmed.startsWith(content)) {
        // Only restore if the comment isn't already present
        if (!line.includes('#')) {
          return `${line} ${comment}`;
        }
      }
    }
    return line;
  });
  return restored.join('\n');
}

/**
 * Strategic merge: tier-aware upsert with pending trait support.
 *
 * - T1/T2: Never auto-write (locked)
 * - T3: High confidence → direct write; Normal → pending accumulation
 * - T4: Direct overwrite
 * - T5: Direct overwrite (system-managed)
 *
 * Also promotes mature pending traits (count >= 3 or high confidence).
 */
function strategicMerge(profile, updates, lockedKeys, pendingTraits, confidenceMap, sourceMap) {
  const result = JSON.parse(JSON.stringify(profile)); // deep clone

  // Walk flat entries from updates
  const flat = flattenObject(updates);
  for (const [key, value] of Object.entries(flat)) {
    // Skip internal metadata keys
    if (key.startsWith('_')) continue;

    // Schema check already done by filterBySchema, but double-check locks
    if (lockedKeys.has(key.split('.')[0])) continue;
    if (isLocked(key)) continue;

    // Null/empty protection — never delete existing values
    if (value === null || value === '') continue;

    const tier = getTier(key);
    if (!tier) continue;

    switch (tier) {
      case 'T1':
      case 'T2':
        continue; // Never auto-write

      case 'T3': {
        const confidence = confidenceMap[key] || 'normal';
        const source = sourceMap[key] || null;
        if (confidence === 'high') {
          setNested(result, key, value);
        } else {
          upsertPending(pendingTraits, key, value, confidence, source);
        }
        break;
      }

      case 'T5':
        setNested(result, key, value);
        break;
    }
  }

  // Promote mature pending traits
  const promotable = getPromotable(pendingTraits);
  for (const { key, value } of promotable) {
    setNested(result, key, value);
  }
  removePromoted(pendingTraits, promotable.map(p => p.key));

  return result;
}

/**
 * Flatten a nested object into dot-path keys.
 * { preferences: { code_style: 'concise' } } → { 'preferences.code_style': 'concise' }
 */
function flattenObject(obj, parentKey = '', result = {}) {
  for (const key of Object.keys(obj)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const value = obj[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      flattenObject(value, fullKey, result);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Get a nested property by dot-path key.
 */
function getNested(obj, dotPath) {
  const keys = dotPath.split('.');
  let current = obj;
  for (const k of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[k];
  }
  return current;
}

/**
 * Set a nested property by dot-path key.
 */
function setNested(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Filter updates object: only keep keys that exist in schema and are not locked.
 * Walks nested objects and builds dot-path keys for checking.
 */
function filterBySchema(obj, parentKey = '') {
  const result = {};
  for (const key of Object.keys(obj)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const value = obj[key];

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // map type: accept entire object as-is, do not recurse into sub-keys
      const def = getDefinition(fullKey);
      if (def && def.type === 'map') {
        if (hasKey(fullKey) && !isLocked(fullKey)) {
          result[key] = value;
        }
      } else {
        const nested = filterBySchema(value, fullKey);
        if (Object.keys(nested).length > 0) {
          result[key] = nested;
        }
      }
    } else {
      // Check schema whitelist — allow if key exists and is not locked
      if (hasKey(fullKey) && !isLocked(fullKey)) {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Truncate all arrays in the profile to half their length.
 */
function truncateArrays(obj) {
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length > 1) {
      obj[key] = obj[key].slice(-Math.ceil(obj[key].length / 2));
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      truncateArrays(obj[key]);
    }
  }
}



/**
 * Clean up: when ack=true, commit consumed buffer state; otherwise keep buffer intact.
 * Always releases lock.
 */
function cleanup({ ack = false, remainingLines = null } = {}) {
  try {
    if (ack) {
      if (Array.isArray(remainingLines) && remainingLines.length > 0) {
        fs.writeFileSync(BUFFER_FILE, remainingLines.join('\n') + '\n', 'utf8');
      } else {
        fs.unlinkSync(BUFFER_FILE);
      }
    }
  } catch { /* non-fatal */ }
  try { fs.unlinkSync(LOCK_FILE); } catch { }
}

// ---------------------------------------------------------
// SESSION LOG — records behavioral patterns per distill cycle
// ---------------------------------------------------------
const SESSION_LOG_FILE = path.join(HOME, '.metame', 'session_log.yaml');
const MAX_SESSION_LOG = 30;

/**
 * Write a session entry to session_log.yaml.
 * @param {object} behavior - The _behavior block from Haiku
 * @param {number} signalCount - Number of signals processed
 * @param {object} [skeleton] - Optional session skeleton from session-analytics
 * @param {object} [summary] - Optional session summary (for long sessions)
 */
function writeSessionLog(behavior, signalCount, skeleton, summary) {
  if (!behavior) return;

  const yaml = require('js-yaml');
  let log = { sessions: [] };
  try {
    if (fs.existsSync(SESSION_LOG_FILE)) {
      log = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8')) || { sessions: [] };
    }
  } catch {
    log = { sessions: [] };
  }

  if (!Array.isArray(log.sessions)) log.sessions = [];

  const entry = {
    ts: new Date().toISOString().slice(0, 10),
    topics: behavior.topics || [],
    zone: behavior.zone || null,
    decision_pattern: behavior.decision_pattern || null,
    cognitive_load: behavior.cognitive_load || null,
    emotional_response: behavior.emotional_response || null,
    avoidance: behavior.avoidance_topics || [],
    signal_count: signalCount,
    session_outcome: behavior.session_outcome || null,
    friction: behavior.friction || [],
    goal_alignment: behavior.goal_alignment || null,
    drift_note: behavior.drift_note || null,
    // From skeleton (if available)
    ...(skeleton ? {
      duration_min: skeleton.duration_min,
      tool_calls: skeleton.total_tool_calls,
      tools: skeleton.tool_counts,
      project: skeleton.project || null,
      branch: skeleton.branch || null,
      intent: skeleton.intent || null,
    } : {}),
    // Summary for long sessions
    ...(summary ? {
      pivots: summary.pivots,
      summary_outcome: summary.outcome,
    } : {}),
  };

  log.sessions.push(entry);

  // FIFO: keep only most recent entries
  if (log.sessions.length > MAX_SESSION_LOG) {
    log.sessions = log.sessions.slice(-MAX_SESSION_LOG);
  }

  fs.writeFileSync(SESSION_LOG_FILE, yaml.dump(log, { lineWidth: -1 }), 'utf8');
}

// ---------------------------------------------------------
// BOOTSTRAP — one-time batch fill of session_log from history
// ---------------------------------------------------------

/**
 * Bootstrap session_log from historical session JSONLs.
 * Called when session_log has fewer than 5 entries.
 * Merges: skeleton (local, FREE) + /insights facets (if available, FREE).
 * Returns number of sessions bootstrapped.
 */
function bootstrapSessionLog() {
  if (!sessionAnalytics) return 0;

  const yaml = require('js-yaml');
  let log = { sessions: [] };
  try {
    if (fs.existsSync(SESSION_LOG_FILE)) {
      log = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8')) || { sessions: [] };
    }
  } catch {
    log = { sessions: [] };
  }
  if (!Array.isArray(log.sessions)) log.sessions = [];

  // Only bootstrap when we have too few entries
  if (log.sessions.length >= 5) return 0;

  // Load /insights facets if available (pre-computed by `claude /insights`)
  const facetsDir = path.join(HOME, '.claude', 'usage-data', 'facets');
  const facets = {};
  try {
    if (fs.existsSync(facetsDir)) {
      for (const file of fs.readdirSync(facetsDir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(facetsDir, file), 'utf8'));
          if (data.session_id) facets[data.session_id] = data;
        } catch { /* skip corrupt facets */ }
      }
    }
  } catch { /* facets not available */ }

  const allSessions = sessionAnalytics.findAllUnanalyzedSessions(30);
  if (allSessions.length === 0) return 0;

  let count = 0;
  for (const session of allSessions) {
    try {
      const skeleton = sessionAnalytics.extractSkeleton(session.path);

      // Skip trivial sessions (< 2 messages or < 1 min)
      if (skeleton.message_count < 2 && skeleton.duration_min < 1) {
        sessionAnalytics.markAnalyzed(skeleton.session_id);
        continue;
      }

      const ts = skeleton.first_ts
        ? new Date(skeleton.first_ts).toISOString().slice(0, 10)
        : new Date(session.mtime).toISOString().slice(0, 10);

      // Merge /insights facet if available for this session
      const facet = facets[skeleton.session_id] || null;

      // Map facet outcome to our session_outcome enum
      let sessionOutcome = null;
      if (facet) {
        const o = facet.outcome;
        if (o === 'fully_achieved') sessionOutcome = 'completed';
        else if (o === 'partially_achieved') sessionOutcome = 'pivoted';
        else if (o === 'not_achieved') sessionOutcome = 'blocked';
        else if (o === 'abandoned') sessionOutcome = 'abandoned';
      }

      // Extract friction keywords from facet
      let friction = [];
      if (facet && facet.friction_counts) {
        friction = Object.keys(facet.friction_counts).slice(0, 3);
      }

      log.sessions.push({
        ts,
        topics: [],
        zone: null,
        decision_pattern: null,
        cognitive_load: null,
        emotional_response: null,
        avoidance: [],
        signal_count: 0,
        session_outcome: sessionOutcome,
        friction,
        goal_alignment: null,
        drift_note: null,
        duration_min: skeleton.duration_min,
        tool_calls: skeleton.total_tool_calls,
        tools: skeleton.tool_counts,
        project: skeleton.project || null,
        branch: skeleton.branch || null,
        intent: facet ? facet.underlying_goal || skeleton.intent : skeleton.intent || null,
      });

      sessionAnalytics.markAnalyzed(skeleton.session_id);
      count++;
    } catch {
      // Skip individual session failures
    }
  }

  if (count === 0) return 0;

  // Sort by date, keep most recent MAX_SESSION_LOG
  log.sessions.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  if (log.sessions.length > MAX_SESSION_LOG) {
    log.sessions = log.sessions.slice(-MAX_SESSION_LOG);
  }

  fs.writeFileSync(SESSION_LOG_FILE, yaml.dump(log, { lineWidth: -1 }), 'utf8');
  return count;
}

// ---------------------------------------------------------
// PATTERN DETECTION — every 5th distill, analyze session_log
// ---------------------------------------------------------

/**
 * Detect repeated behavioral patterns from session history.
 * Called when distill_count % 5 === 0 and there are enough sessions.
 * Also force-runs after bootstrap (regardless of distill_count).
 * Writes results to profile growth.patterns (max 3).
 */
async function detectPatterns(forceRun) {
  const yaml = require('js-yaml');

  // Read session log
  if (!fs.existsSync(SESSION_LOG_FILE)) return;
  const log = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8'));
  if (!log || !Array.isArray(log.sessions) || log.sessions.length < 5) return;

  // Read current profile to check distill_count
  if (!fs.existsSync(BRAIN_FILE)) return;
  const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8'));
  if (!profile) return;

  const distillCount = (profile.evolution && profile.evolution.distill_count) || 0;
  if (!forceRun && (distillCount % 5 !== 0 || distillCount === 0)) return;

  // Take last 20 sessions
  const recent = log.sessions.slice(-20);
  const sessionSummary = recent.map((s, i) => {
    const parts = [`${i + 1}. [${s.ts}]`];
    if (s.project) parts.push(`proj=${s.project}`);
    parts.push(`topics=${(s.topics || []).join(',')}`);
    parts.push(`zone=${s.zone || '?'}`);
    if (s.goal_alignment) parts.push(`goal=${s.goal_alignment}`);
    if (s.drift_note) parts.push(`drift="${s.drift_note}"`);
    if (s.session_outcome) parts.push(`outcome=${s.session_outcome}`);
    if (s.friction && s.friction.length) parts.push(`friction=[${s.friction.join(',')}]`);
    if (s.tool_calls) parts.push(`tools=${s.tool_calls}`);
    if (s.duration_min) parts.push(`${s.duration_min}min`);
    parts.push(`load=${s.cognitive_load || '?'}`);
    parts.push(`avoidance=[${(s.avoidance || []).join(',')}]`);
    return parts.join(' ');
  }).join('\n');

  // Read declared goals for pattern context
  let declaredGoals = '';
  if (sessionAnalytics) {
    try { declaredGoals = sessionAnalytics.formatGoalContext(BRAIN_FILE); } catch { }
  }
  const goalLine = declaredGoals ? `\nUSER'S ${declaredGoals}\n` : '';

  const patternPrompt = `You are a metacognition pattern detector. Analyze these ${recent.length} session summaries and find repeated behavioral patterns.

SESSION HISTORY:
${sessionSummary}
${goalLine}
Find at most 2 patterns from these categories:
1. Avoidance: topics mentioned repeatedly but never acted on
2. Energy: what task types correlate with high/low cognitive load
3. Zone: consecutive comfort zone? frequent panic?
4. Growth: areas where user went from asking questions to giving commands (mastery signal)
5. Friction: recurring pain points across sessions
6. Efficiency: workflow patterns, underutilized tools
7. Drift: sessions where goal_alignment is drifted/partial for 3+ consecutive sessions

RULES:
- Only report patterns with confidence > 0.7 (based on frequency/consistency)
- Each pattern must appear in at least 3 sessions to count
- Be specific and concise (one sentence per pattern)

OUTPUT FORMAT — respond with ONLY a YAML code block:
\`\`\`yaml
patterns:
  - type: avoidance|energy|zone|growth|friction|efficiency|drift
    summary: "one sentence description"
    confidence: 0.7-1.0
\`\`\`

If no clear patterns found: respond with exactly NO_PATTERNS`;

  try {
    const result = await callHaiku(patternPrompt, distillEnv, 30000);

    if (!result || result.includes('NO_PATTERNS')) return;

    const yamlMatch = result.match(/```yaml\n([\s\S]*?)```/) || result.match(/```\n([\s\S]*?)```/);
    if (!yamlMatch) return;

    const parsed = yaml.load(yamlMatch[1].trim());
    if (!parsed || !Array.isArray(parsed.patterns)) return;

    // Validate and cap at 3 patterns
    const validated = parsed.patterns
      .filter(p => p.type && p.summary && p.confidence >= 0.7)
      .slice(0, 3)
      .map(p => ({
        type: p.type,
        summary: p.summary,
        detected: new Date().toISOString().slice(0, 10),
        surfaced: null,
        confidence: p.confidence,
      }));

    if (validated.length === 0) return;

    // Write to profile growth.patterns
    const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    const freshProfile = yaml.load(rawProfile) || {};
    if (!freshProfile.growth) freshProfile.growth = {};
    freshProfile.growth.patterns = validated;

    // Also update zone_history from recent sessions
    const zoneHistory = recent.slice(-10)
      .map(s => {
        if (s.zone === 'comfort') return 'C';
        if (s.zone === 'stretch') return 'S';
        if (s.zone === 'panic') return 'P';
        return '?';
      });
    freshProfile.growth.zone_history = zoneHistory;

    fs.writeFileSync(BRAIN_FILE, yaml.dump(freshProfile, { lineWidth: -1 }), 'utf8');

  } catch {
    // Non-fatal — pattern detection failure shouldn't break anything
  }
}

// Export for use in index.js
module.exports = {
  distill,
  writeSessionLog,
  bootstrapSessionLog,
  detectPatterns,
  _private: {
    mergeCompetenceMap,
    normalizeCompetenceLevel,
    normalizeDomainName,
    sanitizeSlug,
  },
};

// Also allow direct execution
if (require.main === module) {
  (async () => {
    // Bootstrap: if session_log is thin, batch-fill from history
    const bootstrapped = bootstrapSessionLog();
    if (bootstrapped > 0) {
      console.log(`📊 MetaMe: Bootstrapped ${bootstrapped} historical sessions.`);
      // Force pattern detection immediately after bootstrap
      await detectPatterns(true);
    }

    const result = await distill();
    // Write session log if behavior was detected
    if (result.behavior) {
      writeSessionLog(result.behavior, result.signalCount || 0, result.skeleton || null, result.sessionSummary || null);
    }

    // Run pattern detection (only triggers every 5th distill)
    if (!bootstrapped) await detectPatterns();

    if (result.updated) {
      console.log(`🧠 ${result.summary}`);
    } else {
      console.log(`💤 ${result.summary}`);
    }
    // Report estimated token usage for daemon budget tracking
    // Each callHaiku invocation ~2k-5k tokens; estimate from signal count + result size
    const estTokens = Math.ceil(((result.signalCount || 1) * 500) + ((result.summary || '').length / 4));
    console.log(`__TOKENS__:${estTokens}`);
  })();
}

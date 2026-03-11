'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const yaml = require('./resolve-yaml');

const DEFAULT_SOUL_TEMPLATE = (name) => `# Soul

## Identity
你是一个稳定、专业、可信赖的智能体。
长期身份：${name || 'MetaMe Agent'}。

## Mission
围绕当前项目持续协助用户完成目标，优先保证结果可落地。

## Temperament
清晰、克制、严谨、面向结果。

## Judgment
优先保证正确性、稳定性、一致性。

## Boundaries
不编造事实；不跳过验证；发现风险时明确提醒。
`;

const DEFAULT_MEMORY_SNAPSHOT = `# Memory Snapshot

当前尚无足够历史记录。
后续将根据会话、事实提取与反思结果自动更新。
`;

function sanitizeSlug(input, fallback = 'agent') {
  const cleaned = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function normalizeEngine(engine) {
  return String(engine || '').trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
}

function getAgentsRoot(homeDir = os.homedir()) {
  return path.join(homeDir, '.metame', 'agents');
}

function createAgentId({ agentName, projectKey, cwd } = {}) {
  if (projectKey) return sanitizeSlug(projectKey, 'agent');
  if (agentName) return sanitizeSlug(agentName, 'agent');
  if (cwd) return sanitizeSlug(path.basename(String(cwd)), 'agent');
  return 'agent';
}

function getAgentPaths(agentId, homeDir = os.homedir()) {
  const root = getAgentsRoot(homeDir);
  const dir = path.join(root, agentId);
  return {
    root,
    dir,
    yaml: path.join(dir, 'agent.yaml'),
    soul: path.join(dir, 'soul.md'),
    memory: path.join(dir, 'memory-snapshot.md'),
  };
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function readYamlSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return yaml.load(fs.readFileSync(filePath, 'utf8')) || null;
  } catch {
    return null;
  }
}

function ensureAgentFiles({
  agentId,
  agentName,
  projectKey,
  engine,
  aliases = [],
  homeDir = os.homedir(),
}) {
  const paths = getAgentPaths(agentId, homeDir);
  ensureDirSync(paths.dir);

  const existing = readYamlSafe(paths.yaml) || {};
  const payload = {
    id: agentId,
    name: String(agentName || existing.name || agentId),
    project_key: String(projectKey || existing.project_key || ''),
    engine: normalizeEngine(engine || existing.engine),
    aliases: Array.from(new Set([
      ...((Array.isArray(existing.aliases) ? existing.aliases : []).map(String)),
      ...aliases.map(String).filter(Boolean),
    ])),
  };

  fs.writeFileSync(paths.yaml, yaml.dump(payload, { lineWidth: -1 }), 'utf8');
  writeIfMissing(paths.soul, DEFAULT_SOUL_TEMPLATE(payload.name));
  writeIfMissing(paths.memory, DEFAULT_MEMORY_SNAPSHOT);

  return { agentId, paths, metadata: payload };
}

function tryRemoveExisting(filePath) {
  try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
}

/**
 * Create a symlink from linkPath → targetPath with graceful fallbacks for Windows:
 *   1. symlink (relative target, preferred)
 *   2. hardlink (same drive, no privilege needed on most Windows)
 *   3. plain file copy (last resort; note: will not track future changes to target)
 */
function createLinkOrMirror(targetPath, linkPath) {
  tryRemoveExisting(linkPath);

  try {
    // Use absolute symlinks here: agent layer lives under ~/.metame while workspaces can
    // sit on a different top-level tree (/var, /Volumes, etc). Relative links are brittle
    // across those roots and have produced broken SOUL.md/MEMORY.md views.
    fs.symlinkSync(targetPath, linkPath, 'file');
    return { mode: 'symlink', path: linkPath };
  } catch (symlinkErr) {
    const sameRoot = path.parse(targetPath).root.toLowerCase() === path.parse(linkPath).root.toLowerCase();
    if (sameRoot) {
      try {
        fs.linkSync(targetPath, linkPath);
        return { mode: 'hardlink', path: linkPath };
      } catch { /* ignore */ }
    }

    // Last resort: plain copy (no mirror comment — keeps content clean for model consumption)
    const content = fs.readFileSync(targetPath, 'utf8');
    fs.writeFileSync(linkPath, content, 'utf8');
    return { mode: 'mirror', path: linkPath, warning: symlinkErr && symlinkErr.message ? symlinkErr.message : null };
  }
}

/**
 * Ensure CLAUDE.md in workspaceDir has @SOUL.md at the top.
 * If CLAUDE.md does not exist yet, skip — editAgentRoleDefinition will create it later,
 * and createNewWorkspaceAgent will call this again after that.
 * Returns: 'prepended' | 'already-present' | 'skipped'
 */
function ensureClaudeMdSoulImport(workspaceDir) {
  try {
    const claudeMdPath = path.join(workspaceDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) return 'skipped';
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    if (existing.includes('@SOUL.md')) return 'already-present';
    fs.writeFileSync(claudeMdPath, '@SOUL.md' + '\n\n' + existing, 'utf8');
    return 'prepended';
  } catch {
    return 'skipped';
  }
}

function ensureProjectAgentViews(workspaceDir, agentPaths) {
  ensureDirSync(workspaceDir);
  // Inject @SOUL.md import into CLAUDE.md so Claude auto-loads soul on every session.
  ensureClaudeMdSoulImport(workspaceDir);
  return {
    soul: createLinkOrMirror(agentPaths.soul, path.join(workspaceDir, 'SOUL.md')),
    memory: createLinkOrMirror(agentPaths.memory, path.join(workspaceDir, 'MEMORY.md')),
  };
}

function ensureAgentLayer(options) {
  const agentId = options.agentId || createAgentId(options);
  const ensured = ensureAgentFiles({ ...options, agentId });
  const views = options.workspaceDir
    ? ensureProjectAgentViews(options.workspaceDir, ensured.paths)
    : null;
  return { agentId, paths: ensured.paths, metadata: ensured.metadata, views };
}

/**
 * Lazy-migration: repair the agent soul layer for an existing project that predates this system.
 * Safe to call repeatedly — idempotent. Does NOT overwrite existing soul.md or memory-snapshot.md.
 */
function repairAgentLayer(projectKey, project, homeDir = os.homedir()) {
  if (!project || !project.cwd) return null;
  const agentId = project.agent_id || sanitizeSlug(projectKey, 'agent');
  return ensureAgentLayer({
    agentId,
    projectKey,
    agentName: project.name || projectKey,
    workspaceDir: project.cwd,
    engine: normalizeEngine(project.engine),
    aliases: Array.isArray(project.nicknames) ? project.nicknames.map(String) : [],
    homeDir,
  });
}

function trimFileContent(filePath, maxChars = 2400) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return '';
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...[truncated]` : raw;
  } catch {
    return '';
  }
}

function resolveAgentPathsForProject(project = {}, homeDir = os.homedir()) {
  const cwd = project && project.cwd ? String(project.cwd) : '';
  if (project && project.agent_id) {
    return getAgentPaths(String(project.agent_id), homeDir);
  }
  if (cwd) {
    // Fallback for old projects without agent_id: read from project directory directly
    return { soul: path.join(cwd, 'SOUL.md'), memory: path.join(cwd, 'MEMORY.md') };
  }
  return null;
}

/**
 * Build agent context hint.
 *
 * Soul is no longer injected via prompt for either engine — loaded via file system instead,
 * which is persistent across session resumes:
 *   - Claude: @SOUL.md import prepended to CLAUDE.md (auto-loaded by Claude CLI on every session)
 *   - Codex:  AGENTS.md = CLAUDE.md + SOUL.md, merged on each new session start
 *
 * Only memory-snapshot still needs prompt injection (neither engine auto-discovers it).
 * The engineName param is kept for API compatibility.
 */
function buildAgentContextForEngine(project = {}, engineName = 'claude', homeDir = os.homedir()) {
  const paths = resolveAgentPathsForProject(project, homeDir);
  if (!paths) return { soul: '', memory: '', hint: '' };

  const memory = trimFileContent(paths.memory);
  const hint = memory ? '\n\n[Agent memory snapshot:\n' + memory + ']' : '';
  return { soul: '', memory, hint };
}

/** Backward-compat alias — always uses the claude (full-injection) path. */
function buildAgentContextForProject(project = {}, homeDir = os.homedir()) {
  return buildAgentContextForEngine(project, 'claude', homeDir);
}

/**
 * Build memory snapshot markdown from recent session summaries and facts.
 * Used to auto-refresh memory-snapshot.md after sessions.
 */
function buildMemorySnapshotContent(sessions = [], facts = []) {
  const lines = ['# Memory Snapshot', ''];
  if (sessions.length === 0 && facts.length === 0) {
    lines.push('当前尚无足够历史记录。');
    lines.push('后续将根据会话、事实提取与反思结果自动更新。');
    return lines.join('\n');
  }
  if (sessions.length > 0) {
    lines.push('## 近期会话摘要', '');
    for (const s of sessions) {
      const date = s.created_at ? String(s.created_at).slice(0, 10) : '';
      const kw = s.keywords ? `（关键词: ${s.keywords}）` : '';
      lines.push(`- [${date}] ${s.summary || '(无摘要)'}${kw}`);
    }
    lines.push('');
  }
  if (facts.length > 0) {
    lines.push('## 关键事实', '');
    for (const f of facts) {
      lines.push(`- [${f.relation || 'fact'}] ${f.value}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Overwrite memory-snapshot.md for the given agent.
 * Returns true on success, false if the agent directory doesn't exist yet.
 */
function refreshMemorySnapshot(agentId, content, homeDir = os.homedir()) {
  if (!agentId || !content) return false;
  try {
    const paths = getAgentPaths(agentId, homeDir);
    if (!fs.existsSync(paths.dir)) return false;
    fs.writeFileSync(paths.memory, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_SOUL_TEMPLATE,
  DEFAULT_MEMORY_SNAPSHOT,
  sanitizeSlug,
  normalizeEngine,
  getAgentsRoot,
  createAgentId,
  getAgentPaths,
  ensureAgentFiles,
  createLinkOrMirror,
  ensureProjectAgentViews,
  ensureClaudeMdSoulImport,
  ensureAgentLayer,
  repairAgentLayer,
  buildAgentContextForEngine,
  buildAgentContextForProject,
  buildMemorySnapshotContent,
  refreshMemorySnapshot,
};

'use strict';

const crypto = require('crypto');

function normalizeCodexSandboxMode(value, fallback = null) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'read-only' || text === 'readonly') return 'read-only';
  if (text === 'workspace-write' || text === 'workspace') return 'workspace-write';
  if (
    text === 'danger-full-access'
    || text === 'dangerous'
    || text === 'full-access'
    || text === 'full'
    || text === 'bypass'
    || text === 'writable'
  ) return 'danger-full-access';
  return fallback;
}

function normalizeCodexApprovalPolicy(value, fallback = null) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'never' || text === 'no' || text === 'none') return 'never';
  if (text === 'on-failure' || text === 'on_failure' || text === 'failure') return 'on-failure';
  if (text === 'on-request' || text === 'on_request' || text === 'request') return 'on-request';
  if (text === 'untrusted') return 'untrusted';
  return fallback;
}

function normalizeCodexPermissionMeta(meta = {}) {
  const sandboxMode = normalizeCodexSandboxMode(
    meta.sandboxMode || meta.sandbox_mode || meta.permissionMode,
    null
  );
  const approvalPolicy = normalizeCodexApprovalPolicy(
    meta.approvalPolicy || meta.approval_policy,
    null
  );
  if (!sandboxMode && !approvalPolicy) return null;
  return {
    sandboxMode: sandboxMode || 'danger-full-access',
    approvalPolicy: approvalPolicy || 'never',
    permissionMode: sandboxMode || 'danger-full-access',
  };
}

function normalizeEngineName(name) {
  return String(name || 'claude').trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
}

function stripCodexInjectedHints(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n*System hints \(internal, do not mention to user\):[\s\S]*/i, '')
    .replace(/\n*\[Respond in Simplified Chinese[\s\S]*/i, '')
    .replace(/\n*\[Agent memory snapshot:[\s\S]*/i, '')
    .replace(/\n*\[Relevant facts:[\s\S]*/i, '')
    .trim();
}

function looksLikeInternalCodexPrompt(text) {
  const clean = stripCodexInjectedHints(text).trim();
  if (!clean) return true;
  return (
    /^you are a metame\b/i.test(clean)
    || /^you are a meta ?me\b/i.test(clean)
    || /^you are a session reflection assistant\b/i.test(clean)
    || /^you are a metacognition pattern detector\b/i.test(clean)
    || /^you are codex, based on gpt-5\b/i.test(clean)
    || /^\[nightly-reflect]/i.test(clean)
    || /^\[self-reflect]/i.test(clean)
    || /^\[memory-/i.test(clean)
  );
}


function createSessionStore(deps) {
  const {
    fs,
    path,
    HOME,
    loadState,
    saveState,
    log,
    formatRelativeTime,
    cpExtractTimestamp,
  } = deps;

  const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
  const CODEX_DB = path.join(HOME, '.codex', 'state_5.sqlite');
  const _sessionFileCache = new Map(); // sessionId -> { path, ts }
  const _codexRolloutCache = new Map(); // sessionId -> { path, ts }
  let _sessionCache = null;
  let _sessionCacheTime = 0;
  const SESSION_CACHE_TTL = 30000; // 30s — scan is expensive, 10s was too frequent

  function findSessionFile(sessionId) {
    if (!sessionId || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
    const cached = _sessionFileCache.get(sessionId);
    if (cached && Date.now() - cached.ts < 30000) return cached.path;
    const target = sessionId + '.jsonl';
    try {
      for (const proj of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
        const candidate = path.join(CLAUDE_PROJECTS_DIR, proj, target);
        if (fs.existsSync(candidate)) {
          _sessionFileCache.set(sessionId, { path: candidate, ts: Date.now() });
          return candidate;
        }
      }
    } catch { /* ignore */ }
    _sessionFileCache.set(sessionId, { path: null, ts: Date.now() });
    return null;
  }

  function clearSessionFileCache(sessionId) {
    if (!sessionId) return;
    _sessionFileCache.delete(sessionId);
    _codexRolloutCache.delete(sessionId);
  }

  function truncateSessionLastTurn(sessionId) {
    try {
      const sessionFile = findSessionFile(sessionId);
      if (!sessionFile) return 0;
      const fileContent = fs.readFileSync(sessionFile, 'utf8');
      const lines = fileContent.split('\n').filter(l => l.trim());
      let cutIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'user') { cutIdx = i; break; }
        } catch { /* skip malformed lines */ }
      }
      if (cutIdx <= 0) return 0;
      const kept = lines.slice(0, cutIdx);
      fs.writeFileSync(sessionFile, kept.join('\n') + '\n', 'utf8');
      _sessionFileCache.delete(sessionId);
      const removed = lines.length - kept.length;
      log('INFO', `truncateSessionLastTurn: removed ${removed} lines from ${path.basename(sessionFile)}`);
      return removed;
    } catch (e) {
      log('WARN', `truncateSessionLastTurn failed: ${e.message}`);
      return 0;
    }
  }

  function truncateSessionToCheckpoint(sessionId, checkpointMessage) {
    try {
      const cpTs = typeof cpExtractTimestamp === 'function' ? cpExtractTimestamp(checkpointMessage) : null;
      const cpTime = cpTs ? new Date(cpTs).getTime() : 0;
      if (!cpTime) return truncateSessionLastTurn(sessionId);

      const sessionFile = findSessionFile(sessionId);
      if (!sessionFile) return 0;
      const fileContent = fs.readFileSync(sessionFile, 'utf8');
      const lines = fileContent.split('\n').filter(l => l.trim());

      let cutIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'user' && obj.timestamp) {
            const msgTime = new Date(obj.timestamp).getTime();
            if (msgTime && msgTime >= cpTime) { cutIdx = i; break; }
          }
        } catch { /* skip malformed lines */ }
      }
      if (cutIdx <= 0) return truncateSessionLastTurn(sessionId);

      const kept = lines.slice(0, cutIdx);
      fs.writeFileSync(sessionFile, kept.join('\n') + '\n', 'utf8');
      _sessionFileCache.delete(sessionId);
      const removed = lines.length - kept.length;
      log('INFO', `truncateSessionToCheckpoint: removed ${removed} lines from ${path.basename(sessionFile)}`);
      return removed;
    } catch (e) {
      log('WARN', `truncateSessionToCheckpoint failed: ${e.message}`);
      return truncateSessionLastTurn(sessionId);
    }
  }

  function invalidateSessionCache() { _sessionCache = null; }

  // 监听 ~/.claude/projects 目录，手机端新建 session 后桌面端无需重启即可感知
  let _watcher = null;
  let _invalidateDebounce = null;

  function _debouncedInvalidate() {
    if (_invalidateDebounce) return;
    _invalidateDebounce = setTimeout(() => {
      _sessionCache = null;
      _invalidateDebounce = null;
    }, 500);
  }

  function watchSessionFiles() {
    // 先关闭旧 watcher，防止热重载时叠加
    if (_watcher) { try { _watcher.close(); } catch (_) {} _watcher = null; }
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return;
    try {
      _watcher = fs.watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (evt, filename) => {
        if (filename && filename.endsWith('.jsonl')) _debouncedInvalidate();
      });
      _watcher.on('error', (e) => {
        log('WARN', '[session-store] fs.watch error: ' + e.message);
        _watcher = null;
      });
      log('INFO', '[session-store] fs.watch active on ' + CLAUDE_PROJECTS_DIR);
    } catch (e) {
      log('WARN', '[session-store] fs.watch failed, fallback to TTL cache: ' + e.message);
    }
  }

  function stopWatchingSessionFiles() {
    if (_watcher) { try { _watcher.close(); } catch (_) {} _watcher = null; }
  }

  // [M3] 共享辅助：从 reversed JSONL 行数组中提取最后一条外部用户消息（统一规则）
  function extractLastUserFromLines(lines) {
    for (const line of lines) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.type === 'user' && d.message && d.userType !== 'internal') {
          const content = d.message.content;
          let raw = typeof content === 'string' ? content
            : Array.isArray(content) ? (content.find(c => c.type === 'text') || {}).text || '' : '';
          raw = raw.replace(/\[System hints[\s\S]*/i, '')
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
          if (raw.length > 2) return raw.slice(0, 80);
        }
      } catch { /* skip */ }
    }
    return '';
  }

  function scanClaudeSessions() {
    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
      const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      const sessionMap = new Map();
      const projPathCache = new Map();

      for (const proj of projects) {
        const projDir = path.join(CLAUDE_PROJECTS_DIR, proj);
        const indexFile = path.join(projDir, 'sessions-index.json');
        try {
          if (fs.existsSync(indexFile)) {
            const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
            if (data.entries && data.entries.length > 0) {
              const realPath = data.entries[0].projectPath;
              if (realPath) projPathCache.set(proj, realPath);
              for (const entry of data.entries) {
                if (entry.messageCount >= 1) sessionMap.set(entry.sessionId, entry);
              }
            }
          }
          // Fallback: decode projectPath from directory name (e.g. -Users-yaron-AGI-AChat → /Users/yaron/AGI/AChat)
          if (!projPathCache.has(proj) && proj.startsWith('-')) {
            const decoded = proj.replace(/-/g, '/');
            if (fs.existsSync(decoded)) projPathCache.set(proj, decoded);
          }
        } catch { /* skip */ }

        try {
          const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
          for (const file of files) {
            const sessionId = file.replace('.jsonl', '');
            const filePath = path.join(projDir, file);
            const stat = fs.statSync(filePath);
            const fileMtime = stat.mtimeMs;
            const existing = sessionMap.get(sessionId);
            if (!existing || fileMtime > (existing.fileMtime || 0)) {
              const projectPath = projPathCache.get(proj);
              if (!projectPath) continue;
              sessionMap.set(sessionId, {
                sessionId, projectPath, fileMtime,
                modified: new Date(fileMtime).toISOString(),
                messageCount: 1,
                ...(existing || {}),
                fileMtime,
              });
            }
          }
        } catch { /* skip */ }
      }

      const all = Array.from(sessionMap.values()).map((entry) => ({ ...entry, engine: 'claude' }));
      const ENRICH_LIMIT = 20;
      for (let i = 0; i < Math.min(all.length, ENRICH_LIMIT); i++) {
        const s = all[i];
        // [M1] 用 _enriched 标志替代三字段联合判断
        // customTitle 是可选的，无命名 session 合法值为 undefined，不能作为 skip 条件
        if (s._enriched) continue;
        try {
          const sessionFile = findSessionFile(s.sessionId);
          if (!sessionFile) continue;
          const fd = fs.openSync(sessionFile, 'r');
          try {
            if (!s.firstPrompt) {
              const headBuf = Buffer.alloc(8192);
              const headBytes = fs.readSync(fd, headBuf, 0, 8192, 0);
              const headStr = headBuf.toString('utf8', 0, headBytes);
              for (const line of headStr.split('\n')) {
                if (!line) continue;
                try {
                  const d = JSON.parse(line);
                  if (d.type === 'user' && d.message && d.userType !== 'internal') {
                    const content = d.message.content;
                    let raw = '';
                    if (typeof content === 'string') raw = content;
                    else if (Array.isArray(content)) {
                      const txt = content.find(c => c.type === 'text');
                      if (txt) raw = txt.text;
                    }
                    raw = raw.replace(/\n?\[System hints[\s\S]*/i, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
                    if (raw && raw.length > 2) { s.firstPrompt = raw.slice(0, 120); break; }
                  }
                } catch { /* skip line */ }
              }
            }
            // 从尾部读取：customTitle + lastUser（256KB 覆盖 tool-heavy session）
            const stat = fs.fstatSync(fd);
            const tailSize = Math.min(262144, stat.size);
            const tailBuf = Buffer.alloc(tailSize);
            fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
            const tailLines = tailBuf.toString('utf8').split('\n').reverse();
            if (!s.customTitle) {
              for (const line of tailLines) {
                if (!line) continue;
                try {
                  const d = JSON.parse(line);
                  if (d.type === 'custom-title' && d.customTitle) { s.customTitle = d.customTitle; break; }
                } catch { /* skip */ }
              }
            }
            if (!s.lastUser) {
              s.lastUser = extractLastUserFromLines(tailLines);
            }
          } finally {
            fs.closeSync(fd);
          }
          s._enriched = true; // [M1] 标记已完成富化，下次跳过
        } catch { /* non-fatal */ }
      }
      return all;
    } catch {
      return [];
    }
  }

  function scanCodexSessions() {
    let db = null;
    try {
      if (!fs.existsSync(CODEX_DB)) return [];
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(CODEX_DB, { readonly: true });
      const rows = db.prepare(`
        SELECT
          id,
          cwd,
          title,
          first_user_message,
          source,
          rollout_path,
          created_at,
          updated_at,
          tokens_used,
          archived
        FROM threads
        ORDER BY updated_at DESC
        LIMIT 200
      `).all();
      db.close();
      db = null;
      return rows
        .filter((row) => {
          if (row.archived || !row.id || !row.cwd) return false;
          const seedText = String(row.first_user_message || row.title || '').trim();
          const safeSource = String(row.source || '').trim().toLowerCase();
          if (!seedText) return safeSource === 'cli';
          if (safeSource === 'cli') return true;
          return !looksLikeInternalCodexPrompt(seedText);
        })
        .map((row) => {
          const updatedMs = Number(row.updated_at || row.created_at || 0) * 1000;
          const firstPrompt = stripCodexInjectedHints(row.first_user_message || row.title || '');
          const customTitle = stripCodexInjectedHints(row.title || '');
          if (row.rollout_path) {
            _codexRolloutCache.set(String(row.id), { path: String(row.rollout_path), ts: Date.now() });
          }
          return {
            sessionId: String(row.id),
            projectPath: String(row.cwd),
            fileMtime: updatedMs || 0,
            modified: new Date(updatedMs || Date.now()).toISOString(),
            messageCount: row.tokens_used ? '?' : 1,
            customTitle,
            firstPrompt,
            lastUser: firstPrompt,
            _enriched: false,
            engine: 'codex',
          };
        })
        .map((session) => enrichCodexSession(session));
    } catch {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      return [];
    }
  }

  function findCodexSessionFile(sessionId) {
    if (!sessionId || !fs.existsSync(CODEX_DB)) return null;
    const cached = _codexRolloutCache.get(sessionId);
    if (cached && Date.now() - cached.ts < 30000) return cached.path;
    let db = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(CODEX_DB, { readonly: true });
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sessionId);
      db.close();
      db = null;
      const rolloutPath = row && row.rollout_path ? String(row.rollout_path) : null;
      _codexRolloutCache.set(sessionId, { path: rolloutPath, ts: Date.now() });
      return rolloutPath;
    } catch {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      return null;
    }
  }

  function extractCodexMessageText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload)) {
      return payload.map(item => extractCodexMessageText(item)).filter(Boolean).join('\n').trim();
    }
    if (typeof payload !== 'object') return '';
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.message === 'string') return payload.message;
    if (payload.type === 'input_text' || payload.type === 'output_text') return String(payload.text || '');
    if (payload.type === 'message' && Array.isArray(payload.content)) return extractCodexMessageText(payload.content);
    if (Array.isArray(payload.content)) return extractCodexMessageText(payload.content);
    if (payload.payload) return extractCodexMessageText(payload.payload);
    return '';
  }

  function parseCodexSessionPreview(sessionFile) {
    try {
      if (!sessionFile || !fs.existsSync(sessionFile)) return null;
      const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
      let firstUser = '';
      let lastUser = '';
      let lastAssistant = '';
      let fallbackAssistant = '';
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type === 'response_item' && entry.payload && entry.payload.type === 'message') {
          const role = String(entry.payload.role || '').toLowerCase();
          const text = stripCodexInjectedHints(extractCodexMessageText(entry.payload.content || entry.payload));
          if (!text) continue;
          if (role === 'user') {
            if (!firstUser) firstUser = text;
            lastUser = text;
          } else if (role === 'assistant') {
            lastAssistant = text;
          }
        } else if (entry.type === 'event_msg' && entry.payload && entry.payload.type === 'agent_message') {
          const text = stripCodexInjectedHints(extractCodexMessageText(entry.payload.message));
          if (text) fallbackAssistant = text;
        }
      }
      if (!lastAssistant) lastAssistant = fallbackAssistant;
      return (firstUser || lastUser || lastAssistant)
        ? { firstUser, lastUser, lastAssistant }
        : null;
    } catch {
      return null;
    }
  }

  function enrichCodexSession(session) {
    if (!session || session._enriched) return session;
    try {
      const sessionFile = findCodexSessionFile(session.sessionId);
      const preview = parseCodexSessionPreview(sessionFile);
      if (preview) {
        if (preview.firstUser) session.firstPrompt = preview.firstUser.slice(0, 120);
        if (preview.lastUser) session.lastUser = preview.lastUser.slice(0, 120);
      }
      session._enriched = true;
      return session;
    } catch {
      session._enriched = true;
      return session;
    }
  }

  function scanAllSessions() {
    if (_sessionCache && (Date.now() - _sessionCacheTime < SESSION_CACHE_TTL)) return _sessionCache;
    try {
      const all = [...scanClaudeSessions(), ...scanCodexSessions()];
      all.sort((a, b) => {
        const aTime = a.fileMtime || new Date(a.modified).getTime();
        const bTime = b.fileMtime || new Date(b.modified).getTime();
        return bTime - aTime;
      });
      _sessionCache = all;
      _sessionCacheTime = Date.now();
      return all;
    } catch {
      return [];
    }
  }

  function listRecentSessions(limit, cwd, engine) {
    let all = scanAllSessions();
    if (cwd) {
      all = all.filter(s => s.projectPath === cwd);
    }
    if (engine) {
      const safeEngine = String(engine).trim().toLowerCase() === 'codex' ? 'codex' : 'claude';
      all = all.filter(s => (s.engine || 'claude') === safeEngine);
    }
    return all.slice(0, limit || 10);
  }

  function loadSessionTags() {
    try {
      return JSON.parse(fs.readFileSync(path.join(HOME, '.metame', 'session_tags.json'), 'utf8'));
    } catch { return {}; }
  }

  function getSessionFileMtime(sessionId) {
    try {
      if (!sessionId) return null;
      const sessionFile = findSessionFile(sessionId);
      if (sessionFile) return fs.statSync(sessionFile).mtimeMs;
    } catch { /* ignore */ }
    return null;
  }

  function getSessionDisplayTimeMs(session) {
    const realMtime = getSessionFileMtime(session.sessionId, session.projectPath);
    if (Number.isFinite(realMtime) && realMtime > 0) return realMtime;
    if (Number.isFinite(session.fileMtime) && session.fileMtime > 0) return session.fileMtime;
    const modifiedMs = session.modified ? new Date(session.modified).getTime() : NaN;
    if (Number.isFinite(modifiedMs) && modifiedMs > 0) return modifiedMs;
    return Date.now();
  }

  function getSessionRelativeTimeLabel(session) {
    return formatRelativeTime(new Date(getSessionDisplayTimeMs(session)).toISOString());
  }

  function sessionLabel(s) {
    const name = s.customTitle;
    const proj = s.projectPath ? path.basename(s.projectPath) : '';
    const ago = getSessionRelativeTimeLabel(s);
    const shortId = s.sessionId.slice(0, 4);
    const engineTag = (s.engine || 'claude') === 'codex' ? '[codex] ' : '';

    if (name) return `${engineTag}${ago} [${name}] ${proj} #${shortId}`;

    let title = (s.summary || '').slice(0, 20);
    if (!title && s.firstPrompt) {
      title = s.firstPrompt.slice(0, 20);
      if (s.firstPrompt.length > 20) title += '..';
    }
    return `${engineTag}${ago} ${proj ? proj + ': ' : ''}${title || ''} #${shortId}`;
  }

  function sessionDisplayTitle(s, maxLen, sessionTags) {
    maxLen = maxLen || 50;
    const sanitize = (t) => t
      .replace(/\r?\n/g, ' ')
      .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F\uFFFD\uD800-\uDFFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 优先级：name > summary > tags > firstPrompt > sessionId 前缀
    if (s.customTitle) return sanitize(s.customTitle).slice(0, maxLen);

    if (s.summary) {
      const t = sanitize(s.summary);
      if (t.length > 2) return t.slice(0, maxLen);
    }

    const tagEntry = sessionTags && sessionTags[s.sessionId];
    if (tagEntry && tagEntry.name) return sanitize(tagEntry.name).slice(0, maxLen);

    if (s.firstPrompt) {
      const clean = s.firstPrompt
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\[System hints[\s\S]*/i, '')
        .replace(/^[\s\S]*?<\/[^>]+>\s*/s, '') // 剥离 XML 头部标签
        .trim();
      // 取第一行非空、有实际内容（非纯符号/空格）的行
      const firstLine = clean.split('\n')
        .map(l => l.trim())
        .find(l => l.length > 4 && /\p{L}/u.test(l)) || '';
      const sanitized = sanitize(firstLine);
      if (sanitized && sanitized.length > 2) return sanitized.slice(0, maxLen);
    }

    // 最终兜底：显示 session ID 前缀而非空白
    return s.sessionId ? s.sessionId.slice(0, 8) : '';
  }

  function sessionRichLabel(s, index, sessionTags) {
    sessionTags = sessionTags || loadSessionTags();
    const title = sessionDisplayTitle(s, 50, sessionTags);
    const proj = s.projectPath ? path.basename(s.projectPath) : '~';
    const ago = getSessionRelativeTimeLabel(s);
    const shortId = s.sessionId.slice(0, 8);
    const tags = (sessionTags[s.sessionId] && sessionTags[s.sessionId].tags || []).slice(0, 3);
    const engineLabel = (s.engine || 'claude') === 'codex' ? 'codex' : 'claude';

    // [M2] 转义 markdown 特殊字符，防止用户历史消息破坏渲染
    const escapeMd = (t) => t.replace(/[_*`\\]/g, '\\$&');
    // fallback to firstPrompt when lastUser not found in tail
    const snippetRaw = s.lastUser || (s.firstPrompt || '').replace(/<[^>]+>/g, '').replace(/\[System hints[\s\S]*/i, '').trim().slice(0, 80);
    let line = `${index}. ${title}${title.length >= 50 ? '..' : ''}`;  // [M4] title 已有 sessionId 兜底，不会为空
    if (tags.length) line += `  ${tags.map(t => `#${t}`).join(' ')}`;
    line += `\n   📁${proj} · ${ago} · ${engineLabel}`;
    if (snippetRaw && snippetRaw.length > 2) {
      const snippet = escapeMd(snippetRaw.replace(/\n/g, ' ').slice(0, 60));
      line += `\n   💬 ${snippet}${snippetRaw.length > 60 ? '…' : ''}`;
    }
    line += `\n   /resume ${shortId}`;
    return line;
  }

  function buildSessionCardElements(sessions) {
    const sessionTags = loadSessionTags();
    const elements = [];
    sessions.forEach((s, i) => {
      if (i > 0) elements.push({ tag: 'hr' });
      const title = sessionDisplayTitle(s, 60, sessionTags);
      const proj = s.projectPath ? path.basename(s.projectPath) : '~';
      const ago = getSessionRelativeTimeLabel(s);
      const shortId = s.sessionId.slice(0, 6);
      const tags = (sessionTags[s.sessionId] && sessionTags[s.sessionId].tags || []).slice(0, 4);
      const engineLabel = (s.engine || 'claude') === 'codex' ? 'codex' : 'claude';
      // [M2] 转义 markdown 特殊字符；[M4] title 已有 sessionId 兜底
      const escapeMd = (t) => t.replace(/[_*`\\]/g, '\\$&');
      const snippetRaw = s.lastUser || (s.firstPrompt || '').replace(/<[^>]+>/g, '').replace(/\[System hints[\s\S]*/i, '').trim().slice(0, 80);
      let desc = `**${i + 1}. ${title}**\n📁${proj} · ${ago} · ${engineLabel}`;
      if (tags.length) desc += `\n${tags.map(t => `\`${t}\``).join(' ')}`;
      if (snippetRaw && snippetRaw.length > 2) {
        const snippet = escapeMd(snippetRaw.replace(/\n/g, ' ').slice(0, 60));
        desc += `\n💬 ${snippet}${snippetRaw.length > 60 ? '…' : ''}`;
      }
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: desc } });
      elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: `▶️ Switch #${shortId}` }, type: 'primary', value: { cmd: `/resume ${s.sessionId}` } }] });
    });
    return elements;
  }

  function listProjectDirs() {
    try {
      const all = listRecentSessions(50);
      const seen = new Map();
      for (const s of all) {
        if (!s.projectPath || !fs.existsSync(s.projectPath)) continue;
        const prev = seen.get(s.projectPath);
        if (!prev || new Date(s.modified) > new Date(prev)) seen.set(s.projectPath, s.modified);
      }
      return [...seen.entries()]
        .sort((a, b) => new Date(b[1]) - new Date(a[1]))
        .slice(0, 6)
        .map(([p]) => ({ path: p, label: path.basename(p) }));
    } catch {
      return [];
    }
  }

  function sanitizeCwd(cwd) {
    try {
      const resolved = path.resolve(String(cwd || HOME));
      if (process.platform === 'win32' && !/^[A-Za-z]:[\\\/]/i.test(resolved)) return HOME;
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory()) return HOME;
      return resolved;
    } catch { return HOME; }
  }

  function getSession(chatId) {
    const state = loadState();
    return state.sessions[chatId] || null;
  }

  function getSessionForEngine(chatId, engine) {
    const raw = getSession(chatId);
    if (!raw) return null;
    const safeEngine = normalizeEngineName(engine);
    if (!raw.engines) return { cwd: raw.cwd, engine: safeEngine, id: raw.id || null, started: !!raw.started };
    const slot = raw.engines[safeEngine] || {};
    return {
      cwd: raw.cwd,
      engine: safeEngine,
      ...slot,
      id: slot.id || null,
      started: !!slot.started,
    };
  }

  function upgradeSessionRecord(raw = {}, fallbackEngine = 'claude') {
    const safeEngine = normalizeEngineName(fallbackEngine);
    if (raw.engines && typeof raw.engines === 'object') {
      return {
        cwd: sanitizeCwd(raw.cwd),
        engines: { ...raw.engines },
        ...(raw.last_active ? { last_active: raw.last_active } : {}),
      };
    }
    const slot = {
      id: raw.id || null,
      started: !!raw.started,
    };
    if (safeEngine === 'codex') {
      const permissionMeta = normalizeCodexPermissionMeta(raw);
      if (permissionMeta) Object.assign(slot, permissionMeta);
    }
    return {
      cwd: sanitizeCwd(raw.cwd),
      engines: { [safeEngine]: slot },
      ...(raw.last_active ? { last_active: raw.last_active } : {}),
    };
  }

  function createSession(chatId, cwd, name, engine = 'claude', meta = {}) {
    const state = loadState();
    const safeEngine = normalizeEngineName(engine);
    const safeCwd = sanitizeCwd(cwd);
    const sessionId = crypto.randomUUID();
    const existing = upgradeSessionRecord(state.sessions[chatId] || {}, safeEngine);
    const existingEngines = existing.engines || {};
    const nextSlot = { id: sessionId, started: false };
    if (safeEngine === 'codex') {
      nextSlot.runtimeSessionObserved = false;
      const permissionMeta = normalizeCodexPermissionMeta(meta);
      if (permissionMeta) Object.assign(nextSlot, permissionMeta);
    }
    state.sessions[chatId] = {
      cwd: safeCwd,
      engines: { ...existingEngines, [safeEngine]: nextSlot },
      last_active: Date.now(),
    };
    saveState(state);
    invalidateSessionCache();
    if (name) writeSessionName(sessionId, safeCwd, name);
    log('INFO', `New session for ${chatId}: ${sessionId}${name ? ' [' + name + ']' : ''} (cwd: ${safeCwd}) [${safeEngine}]`);
    return getSessionForEngine(chatId, safeEngine);
  }

  function restoreSessionFromReply(chatId, mapped = {}) {
    if (!chatId || !mapped) return null;
    const safeEngine = normalizeEngineName(mapped.engine);
    const state = loadState();
    if (!state.sessions) state.sessions = {};
    const logicalChatId = String(mapped.logicalChatId || '').trim();
    const targetChatId = logicalChatId || String(chatId);
    const base = upgradeSessionRecord(state.sessions[targetChatId] || {}, safeEngine);
    const logicalBase = logicalChatId
      ? upgradeSessionRecord(state.sessions[logicalChatId] || {}, safeEngine)
      : null;
    const logicalSlot = logicalBase && logicalBase.engines
      ? (logicalBase.engines[safeEngine] || null)
      : null;
    const effectiveMapped = (logicalSlot && logicalSlot.id)
      ? {
          ...mapped,
          ...logicalSlot,
          id: String(logicalSlot.id),
          cwd: logicalBase.cwd || mapped.cwd,
          engine: safeEngine,
          logicalChatId,
        }
      : mapped;
    const resolvedId = String(effectiveMapped.id || '').trim();
    const resolvedCwd = sanitizeCwd(effectiveMapped.cwd || base.cwd);
    if (!resolvedId && !resolvedCwd) return null;
    const restoredSlot = {
      ...(base.engines[safeEngine] || {}),
      ...(resolvedId ? { id: resolvedId } : {}),
      started: true,
    };
    if (safeEngine === 'codex') {
      restoredSlot.runtimeSessionObserved = !!resolvedId;
      const permissionMeta = normalizeCodexPermissionMeta(effectiveMapped) || normalizeCodexPermissionMeta(restoredSlot);
      if (permissionMeta) Object.assign(restoredSlot, permissionMeta);
    }
    const restoredRecord = {
      cwd: resolvedCwd,
      engines: {
        ...base.engines,
        [safeEngine]: restoredSlot,
      },
      last_active: Date.now(),
    };
    state.sessions[targetChatId] = restoredRecord;
    if (String(chatId) !== targetChatId) {
      const aliasBase = upgradeSessionRecord(state.sessions[chatId] || {}, safeEngine);
      state.sessions[chatId] = {
        cwd: restoredRecord.cwd,
        engines: {
          ...aliasBase.engines,
          [safeEngine]: { ...(aliasBase.engines[safeEngine] || {}), ...restoredSlot },
        },
        last_active: restoredRecord.last_active,
      };
    }
    saveState(state);
    return getSessionForEngine(targetChatId, safeEngine);
  }

  function getSessionName(sessionId) {
    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return '';
      const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
      for (const proj of projects) {
        const indexFile = path.join(CLAUDE_PROJECTS_DIR, proj, 'sessions-index.json');
        if (!fs.existsSync(indexFile)) continue;
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        if (data.entries) {
          const entry = data.entries.find(e => e.sessionId === sessionId);
          if (entry && entry.customTitle) return entry.customTitle;
        }
      }
    } catch { /* ignore */ }
    return '';
  }

  function writeSessionName(sessionId, cwd, name) {
    void cwd;
    try {
      // Clear stale cache — JSONL may have just been created by spawnClaudeStreaming
      clearSessionFileCache(sessionId);
      const sessionFile = findSessionFile(sessionId);
      if (!sessionFile) {
        log('WARN', `writeSessionName: session file not found for ${sessionId.slice(0, 8)}`);
        return;
      }
      const entry = JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }) + '\n';
      fs.appendFileSync(sessionFile, entry, 'utf8');
      log('INFO', `Named session ${sessionId.slice(0, 8)}: ${name}`);
      return true;
    } catch (e) {
      log('WARN', `Failed to write session name: ${e.message}`);
      return false;
    }
  }

  /**
   * 读取 session 最近一条用户消息 + 最近一条 AI 回复
   * 用于 /resume 后帮助确认切换到正确 session
   */
  function getSessionRecentContext(sessionId) {
    try {
      const sessionFile = findSessionFile(sessionId);
      if (sessionFile) {
        const stat = fs.statSync(sessionFile);
        const tailSize = Math.min(262144, stat.size); // 256KB for better coverage of tool-heavy sessions
        const buf = Buffer.alloc(tailSize);
        const fd = fs.openSync(sessionFile, 'r');
        try {
          fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
        } finally {
          fs.closeSync(fd);
        }
        const lines = buf.toString('utf8').split('\n').reverse();
        // [M3] 复用共享函数，统一截取逻辑
        const lastUser = extractLastUserFromLines(lines);
        let lastAssistant = '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (!lastAssistant && d.type === 'assistant' && d.message) {
              const content = d.message.content;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (c.type === 'text' && c.text && c.text.trim().length > 2) {
                    lastAssistant = c.text.trim().slice(0, 80);
                    break;
                  }
                }
              }
            }
            if (lastAssistant) break;
          } catch { /* skip bad line */ }
        }
        return (lastUser || lastAssistant) ? { lastUser, lastAssistant } : null;
      }
      const codexFile = findCodexSessionFile(sessionId);
      const preview = parseCodexSessionPreview(codexFile);
      if (!preview) return null;
      return {
        lastUser: (preview.lastUser || '').slice(0, 80),
        lastAssistant: (preview.lastAssistant || '').slice(0, 80),
      };
    } catch { return null; }
  }

  function markSessionStarted(chatId, engine) {
    const state = loadState();
    const s = state.sessions[chatId];
    if (!s) return;
    if (s.engines) {
      const safeEngine = normalizeEngineName(engine);
      if (!s.engines[safeEngine]) s.engines[safeEngine] = {};
      const slot = s.engines[safeEngine];
      if (safeEngine === 'codex' && slot.runtimeSessionObserved === false) {
        s.last_active = Date.now();
        saveState(state);
        return;
      }
      slot.started = true;
      s.last_active = Date.now();
      // Clear stale findSessionFile cache: the JSONL/SQLite file now exists
      // but may have been cached as null during createSession (before CLI created it).
      if (slot.id) clearSessionFileCache(slot.id);
    } else {
      s.started = true; // old flat format
      s.last_active = Date.now();
    }
    saveState(state);
  }

  // Codex session validation via ~/.codex/state_5.sqlite
  // ─── Unified session validation ──────────────────────────────────────────
  // Both engines store sessions locally; only the backend differs.
  // Single entry point: isEngineSessionValid(engine, sessionId, cwd)

  const SESSION_VALIDATE_TTL = 30000;
  const _validateCache = new Map(); // `${engine}@@${sessionId}@@${cwd}` -> { valid, ts }

  function _cacheValidation(key, valid) {
    _validateCache.set(key, { valid: !!valid, ts: Date.now() });
    if (_validateCache.size > 512) _validateCache.delete(_validateCache.keys().next().value);
    return !!valid;
  }

  function _readClaudeSessionMetadata(sessionFile) {
    const content = fs.readFileSync(sessionFile, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const metadata = {
      lines,
      cwd: '',
      model: '',
    };
    for (const line of lines.slice(0, 20)) {
      try {
        const entry = JSON.parse(line);
        const fileCwd = entry.cwd || (entry.message && entry.message.cwd);
        if (!metadata.cwd && fileCwd) metadata.cwd = fileCwd;
        const sessionModel = entry && entry.message && entry.message.model;
        if (!metadata.model && sessionModel && sessionModel !== '<synthetic>') metadata.model = sessionModel;
        if (metadata.cwd && metadata.model) break;
      } catch { /* skip non-JSON lines */ }
    }
    return metadata;
  }

  // Claude backend: JSONL files under ~/.claude/projects/<hash>/
  // Best approach: read cwd directly from session file content (not from dir name)
  function _isClaudeSessionValid(sessionId, normCwd) {
    try {
      let sessionFile = findSessionFile(sessionId);
      if (!sessionFile) {
        // Cache may hold a stale null from createSession (before CLI wrote the JSONL).
        // Clear and retry once to avoid false invalidation.
        clearSessionFileCache(sessionId);
        sessionFile = findSessionFile(sessionId);
      }
      if (!sessionFile) {
        log('WARN', `[SessionValid] ${sessionId.slice(0, 8)}: JSONL file not found`);
        return false;
      }

      // Try to read cwd/model from session JSONL file content (most reliable)
      const metadata = _readClaudeSessionMetadata(sessionFile);
      if (metadata.model && !metadata.model.startsWith('claude-')) {
        log('WARN', `[SessionValid] ${sessionId.slice(0, 8)}: non-claude model "${metadata.model}"`);
        return false;
      }
      if (metadata.cwd && path.resolve(metadata.cwd) === normCwd) return true;
      if (metadata.cwd) {
        // CWD mismatch: the session was created for a different directory.
        // However, if the JSONL file exists and has Claude content, the session is still
        // usable — the cwd might have changed due to worktree cleanup, config reload, etc.
        // Log the mismatch but allow resuming (Claude CLI handles cwd internally).
        log('INFO', `[SessionValid] ${sessionId.slice(0, 8)}: cwd mismatch (jsonl="${metadata.cwd}" vs expected="${normCwd}") — allowing resume`);
        return true;
      }
      for (const line of metadata.lines.slice(0, 20)) { // preserve tolerant parsing for malformed heads
        try {
          const entry = JSON.parse(line);
          const fileCwd = entry.cwd || (entry.message && entry.message.cwd);
          if (fileCwd && path.resolve(fileCwd) === normCwd) return true;
        } catch { /* skip non-JSON lines */ }
      }

      // JSONL exists but has no cwd metadata — trust it (e.g., very short session,
      // or JSONL format changed). Better to attempt resume than force a new session.
      log('INFO', `[SessionValid] ${sessionId.slice(0, 8)}: no cwd in JSONL, trusting file existence`);
      return true;
    } catch (e) {
      log('WARN', `[SessionValid] ${sessionId.slice(0, 8)}: infra error "${e.message}" — trusting session`);
      return true; // conservative: infra failure ≠ invalid session
    }
  }

  function _isCodexSessionValid(sessionId, normCwd) {
    let db = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(CODEX_DB, { readonly: true });
      const row = db.prepare('SELECT cwd FROM threads WHERE id = ?').get(sessionId);
      db.close();
      db = null;
      return !!row && path.resolve(row.cwd) === normCwd;
    } catch (e) {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      // Transient errors (DB locked, busy) should not invalidate a live session.
      // Only treat "session truly not found" as invalid; infra failures are conservative.
      const msg = (e && e.message) || '';
      if (msg.includes('SQLITE_BUSY') || msg.includes('SQLITE_LOCKED')) return true;
      return false;
    }
  }

  function getCodexSessionSandboxProfile(sessionId) {
    let db = null;
    try {
      if (!sessionId) return null;
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(CODEX_DB, { readonly: true });
      const row = db.prepare('SELECT sandbox_policy, approval_mode FROM threads WHERE id = ?').get(sessionId);
      db.close();
      db = null;
      if (!row || !row.sandbox_policy) return null;
      const policy = JSON.parse(String(row.sandbox_policy));
      const sandboxMode = normalizeCodexSandboxMode(
        policy && (policy.type || policy.mode || policy.sandbox_mode || policy.sandboxMode),
        null
      );
      const approvalPolicy = normalizeCodexApprovalPolicy(
        (policy && (policy.approval_policy || policy.approvalPolicy || policy.ask_for_approval)) || row.approval_mode,
        null
      );
      if (!sandboxMode && !approvalPolicy) return null;
      return {
        sandboxMode: sandboxMode || 'danger-full-access',
        approvalPolicy,
        permissionMode: sandboxMode || 'danger-full-access',
      };
    } catch {
      if (db) { try { db.close(); } catch { /* ignore */ } }
      return null;
    }
  }

  function getCodexSessionPermissionMode(sessionId) {
    const profile = getCodexSessionSandboxProfile(sessionId);
    return profile ? profile.permissionMode : null;
  }

  function isEngineSessionValid(engine, sessionId, cwd) {
    if (!sessionId || !cwd || sessionId === '__continue__') return true;
    const normCwd = path.resolve(cwd);
    const key = `${engine}@@${sessionId}@@${normCwd}`;
    const cached = _validateCache.get(key);
    if (cached && Date.now() - cached.ts < SESSION_VALIDATE_TTL) return cached.valid;
    const valid = engine === 'codex'
      ? _isCodexSessionValid(sessionId, normCwd)
      : _isClaudeSessionValid(sessionId, normCwd);
    return _cacheValidation(key, valid);
  }

  return {
    findSessionFile,
    findCodexSessionFile,
    clearSessionFileCache,
    truncateSessionToCheckpoint,
    watchSessionFiles,
    stopWatchingSessionFiles,
    listRecentSessions,
    loadSessionTags,
    getSessionFileMtime,
    sessionLabel,
    sessionRichLabel,
    buildSessionCardElements,
    listProjectDirs,
    getSession,
    getSessionForEngine,
    createSession,
    restoreSessionFromReply,
    getSessionName,
    writeSessionName,
    markSessionStarted,
    getSessionRecentContext,
    isEngineSessionValid,
    getCodexSessionSandboxProfile,
    getCodexSessionPermissionMode,
    _private: {
      _readClaudeSessionMetadata,
      _isClaudeSessionValid,
      upgradeSessionRecord,
      stripCodexInjectedHints,
      looksLikeInternalCodexPrompt,
      parseCodexSessionPreview,
    },
  };
}

module.exports = { createSessionStore };

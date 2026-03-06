'use strict';

const crypto = require('crypto');

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
  const _sessionFileCache = new Map(); // sessionId -> { path, ts }
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

  function scanAllSessions() {
    if (_sessionCache && (Date.now() - _sessionCacheTime < SESSION_CACHE_TTL)) return _sessionCache;
    try {
      if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) { _sessionCache = []; _sessionCacheTime = Date.now(); return []; }
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
              const projectPath = projPathCache.get(proj) || proj.slice(1).replace(/-/g, '/');
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

      const all = Array.from(sessionMap.values());
      all.sort((a, b) => {
        const aTime = a.fileMtime || new Date(a.modified).getTime();
        const bTime = b.fileMtime || new Date(b.modified).getTime();
        return bTime - aTime;
      });

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

      _sessionCache = all;
      _sessionCacheTime = Date.now();
      return all;
    } catch {
      return [];
    }
  }

  function listRecentSessions(limit, cwd) {
    let all = scanAllSessions();
    if (cwd) {
      const matched = all.filter(s => s.projectPath === cwd);
      if (matched.length > 0) all = matched;
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

  function sessionLabel(s) {
    const name = s.customTitle;
    const proj = s.projectPath ? path.basename(s.projectPath) : '';
    const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
    const timeMs = realMtime || s.fileMtime || new Date(s.modified).getTime();
    const ago = formatRelativeTime(new Date(timeMs).toISOString());
    const shortId = s.sessionId.slice(0, 4);

    if (name) return `${ago} [${name}] ${proj} #${shortId}`;

    let title = (s.summary || '').slice(0, 20);
    if (!title && s.firstPrompt) {
      title = s.firstPrompt.slice(0, 20);
      if (s.firstPrompt.length > 20) title += '..';
    }
    return `${ago} ${proj ? proj + ': ' : ''}${title || ''} #${shortId}`;
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
    const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
    const timeMs = realMtime || s.fileMtime || new Date(s.modified).getTime();
    const ago = formatRelativeTime(new Date(timeMs).toISOString());
    const shortId = s.sessionId.slice(0, 8);
    const tags = (sessionTags[s.sessionId] && sessionTags[s.sessionId].tags || []).slice(0, 3);

    // [M2] 转义 markdown 特殊字符，防止用户历史消息破坏渲染
    const escapeMd = (t) => t.replace(/[_*`\\]/g, '\\$&');
    // fallback to firstPrompt when lastUser not found in tail
    const snippetRaw = s.lastUser || (s.firstPrompt || '').replace(/<[^>]+>/g, '').replace(/\[System hints[\s\S]*/i, '').trim().slice(0, 80);
    let line = `${index}. ${title}${title.length >= 50 ? '..' : ''}`;  // [M4] title 已有 sessionId 兜底，不会为空
    if (tags.length) line += `  ${tags.map(t => `#${t}`).join(' ')}`;
    line += `\n   📁${proj} · ${ago}`;
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
      const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
      const timeMs = realMtime || s.fileMtime || new Date(s.modified).getTime();
      const ago = formatRelativeTime(new Date(timeMs).toISOString());
      const shortId = s.sessionId.slice(0, 6);
      const tags = (sessionTags[s.sessionId] && sessionTags[s.sessionId].tags || []).slice(0, 4);
      // [M2] 转义 markdown 特殊字符；[M4] title 已有 sessionId 兜底
      const escapeMd = (t) => t.replace(/[_*`\\]/g, '\\$&');
      const snippetRaw = s.lastUser || (s.firstPrompt || '').replace(/<[^>]+>/g, '').replace(/\[System hints[\s\S]*/i, '').trim().slice(0, 80);
      let desc = `**${i + 1}. ${title}**\n📁${proj} · ${ago}`;
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

  function getSession(chatId) {
    const state = loadState();
    return state.sessions[chatId] || null;
  }

  function createSession(chatId, cwd, name, engine = 'claude') {
    const state = loadState();
    const sessionId = crypto.randomUUID();
    state.sessions[chatId] = {
      id: sessionId,
      cwd: cwd || HOME,
      started: false,
      engine: String(engine || 'claude').trim().toLowerCase() === 'codex' ? 'codex' : 'claude',
    };
    saveState(state);
    invalidateSessionCache();
    if (name) writeSessionName(sessionId, cwd || HOME, name);
    log('INFO', `New session for ${chatId}: ${sessionId}${name ? ' [' + name + ']' : ''} (cwd: ${state.sessions[chatId].cwd})`);
    return { ...state.sessions[chatId], id: sessionId };
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
      if (!sessionFile) return null;
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
    } catch { return null; }
  }

  function markSessionStarted(chatId) {
    const state = loadState();
    if (state.sessions[chatId]) {
      state.sessions[chatId].started = true;
      saveState(state);
    }
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

  // Claude backend: JSONL files under ~/.claude/projects/<hash>/
  function _isClaudeSessionValid(sessionId, normCwd) {
    try {
      const sessionFile = findSessionFile(sessionId);
      if (!sessionFile) return false;
      const projectDir = path.dirname(sessionFile);
      const indexFile = path.join(projectDir, 'sessions-index.json');
      if (fs.existsSync(indexFile)) {
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        const entries = Array.isArray(data && data.entries) ? data.entries : [];
        const entry = entries.find(e => e && e.sessionId === sessionId);
        if (entry && entry.projectPath) return path.resolve(entry.projectPath) === normCwd;
        const anyPath = (entries.find(e => e && e.projectPath) || {}).projectPath;
        if (anyPath) return path.resolve(anyPath) === normCwd;
      }
      // Weak fallback: Claude encodes cwd in dir name; only trust a positive match.
      // Unix: /home/user/project → -home-user-project
      // Windows: D:\MetaMe → D--MetaMe (replaces : and \ with -)
      const actualDir = path.basename(projectDir).toLowerCase();
      const expectedDir = process.platform === 'win32'
        ? normCwd.replace(/[:\\\/_ ]/g, '-').toLowerCase()
        : ('-' + normCwd.replace(/^\//, '').replace(/[\/_ ]/g, '-')).toLowerCase();
      if (actualDir === expectedDir) return true;
      return false; // dir name mismatch — session belongs to a different project
    } catch {
      return true; // conservative: infra failure ≠ invalid session
    }
  }

  // Codex backend: SQLite index at ~/.codex/state_5.sqlite
  const CODEX_DB = path.join(HOME, '.codex', 'state_5.sqlite');
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
    createSession,
    getSessionName,
    writeSessionName,
    markSessionStarted,
    getSessionRecentContext,
    isEngineSessionValid,
  };
}

module.exports = { createSessionStore };

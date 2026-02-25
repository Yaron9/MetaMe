'use strict';

const { classifyChatUsage } = require('./usage-classifier');

function createClaudeEngine(deps) {
  const {
    fs,
    path,
    spawn,
    CLAUDE_BIN,
    HOME,
    CONFIG_FILE,
    getActiveProviderEnv,
    activeProcesses,
    saveActivePids,
    messageQueue,
    log,
    yaml,
    providerMod,
    writeConfigSafe,
    loadConfig,
    loadState,
    saveState,
    routeAgent,
    routeSkill,
    attachOrCreateSession,
    normalizeCwd,
    isContentFile,
    sendFileButtons,
    findSessionFile,
    listRecentSessions,
    getSession,
    createSession,
    getSessionName,
    writeSessionName,
    markSessionStarted,
    gitCheckpoint,
    recordTokens,
    skillEvolution,
    touchInteraction,
    statusThrottleMs = 3000,
    fallbackThrottleMs = 8000,
  } = deps;
  const SESSION_CWD_VALIDATION_TTL_MS = 30 * 1000;
  const _sessionCwdValidationCache = new Map(); // key: `${sessionId}@@${cwd}` -> { inCwd, ts }

  function cacheSessionCwdValidation(cacheKey, inCwd) {
    _sessionCwdValidationCache.set(cacheKey, { inCwd: !!inCwd, ts: Date.now() });
    if (_sessionCwdValidationCache.size > 512) {
      const firstKey = _sessionCwdValidationCache.keys().next().value;
      if (firstKey) _sessionCwdValidationCache.delete(firstKey);
    }
    return !!inCwd;
  }

  function isSessionInCwd(sessionId, cwd) {
    const safeSessionId = String(sessionId || '').trim();
    if (!safeSessionId || !cwd) return false;

    const normCwd = normalizeCwd(cwd);
    const cacheKey = `${safeSessionId}@@${normCwd}`;
    const cached = _sessionCwdValidationCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < SESSION_CWD_VALIDATION_TTL_MS) {
      return !!cached.inCwd;
    }

    try {
      // Fast path: locate the exact session file, then validate its indexed projectPath.
      if (typeof findSessionFile === 'function') {
        const sessionFile = findSessionFile(safeSessionId);
        if (!sessionFile) return cacheSessionCwdValidation(cacheKey, false);

        const projectDir = path.dirname(sessionFile);
        const indexFile = path.join(projectDir, 'sessions-index.json');
        if (fs.existsSync(indexFile)) {
          const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
          const entries = Array.isArray(data && data.entries) ? data.entries : [];
          const entry = entries.find(e => e && e.sessionId === safeSessionId);
          if (entry && entry.projectPath) {
            return cacheSessionCwdValidation(cacheKey, normalizeCwd(entry.projectPath) === normCwd);
          }
          // sessions-index may lag behind new sessions; use project-level path from any entry.
          const anyProjectPath = (entries.find(e => e && e.projectPath) || {}).projectPath;
          if (anyProjectPath) {
            return cacheSessionCwdValidation(cacheKey, normalizeCwd(anyProjectPath) === normCwd);
          }
        }

        // Weak fallback: encode normCwd using Claude's folder convention and accept
        // only positive match. If it doesn't match, keep current session to avoid
        // false mismatches for paths with non-ASCII/special characters.
        const expectedDirName = '-' + normCwd.replace(/^\//, '').replace(/[\/_ ]/g, '-');
        const actualDirName = path.basename(projectDir);
        if (actualDirName === expectedDirName) {
          return cacheSessionCwdValidation(cacheKey, true);
        }
        // Unable to prove mismatch safely.
        return cacheSessionCwdValidation(cacheKey, true);
      }

      // Ultimate fallback (legacy path): scoped scan in target cwd.
      const recentInCwd = listRecentSessions(1000, normCwd);
      const existsInCwd = recentInCwd.some(s => s.sessionId === safeSessionId);
      return cacheSessionCwdValidation(cacheKey, existsInCwd);
    } catch {
      // Conservative fallback: if validation infra fails, avoid false positives by preserving current session.
      return cacheSessionCwdValidation(cacheKey, true);
    }
  }

  /**
   * Parse [[FILE:...]] markers from Claude output.
   * Returns { markedFiles, cleanOutput }
   */
  function parseFileMarkers(output) {
    const markers = output.match(/\[\[FILE:([^\]]+)\]\]/g) || [];
    const markedFiles = markers.map(m => m.match(/\[\[FILE:([^\]]+)\]\]/)[1].trim());
    const cleanOutput = output.replace(/\s*\[\[FILE:[^\]]+\]\]/g, '').trim();
    return { markedFiles, cleanOutput };
  }

  /**
   * Merge explicit [[FILE:...]] paths with auto-detected content files.
   * Returns a Set of unique file paths.
   */
  function mergeFileCollections(markedFiles, sourceFiles) {
    const result = new Set(markedFiles);
    if (sourceFiles && sourceFiles.length > 0) {
      for (const f of sourceFiles) { if (isContentFile(f)) result.add(f); }
    }
    return result;
  }

  /**
   * Build a richer fact-retrieval query from the user prompt.
   * Adds lightweight code anchors (filenames/commands/identifiers) for better recall.
   */
  function buildFactSearchQuery(prompt, projectKey) {
    const text = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!text) return projectKey || '';

    const anchors = [];
    const seen = new Set();
    const add = (v) => {
      const t = String(v || '').trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      anchors.push(t);
    };

    // File/path-like anchors: daemon.js, scripts/memory-extract.js, foo.ts
    const fileLike = text.match(/\b(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8}\b/g) || [];
    for (const f of fileLike.slice(0, 6)) {
      add(path.basename(f));
    }

    // Command-like anchors: git commit, npm run build, node index.js ...
    const cmdLike = text.match(/\b(?:git|npm|pnpm|yarn|npx|node|python|pytest|make)\b[^,.;\n]{0,48}/gi) || [];
    for (const c of cmdLike.slice(0, 4)) {
      add(c.toLowerCase());
    }

    // Symbol-like anchors: snake_case / camelCase identifiers often present in bug reports
    const idLike = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
    for (const id of idLike) {
      if (anchors.length >= 12) break;
      if (id.includes('_') || /[a-z][A-Z]/.test(id)) add(id);
    }

    const parts = [text.slice(0, 260)];
    if (projectKey) parts.push(projectKey);
    if (anchors.length > 0) parts.push(anchors.slice(0, 10).join(' '));
    return parts.join(' ').slice(0, 520);
  }

  function projectKeyFromVirtualChatId(chatId) {
    const v = String(chatId || '');
    if (v.startsWith('_agent_')) return v.slice(7) || null;
    if (v.startsWith('_scope_')) {
      const idx = v.lastIndexOf('__');
      if (idx > 7 && idx + 2 < v.length) return v.slice(idx + 2);
    }
    return null;
  }

  function isMacAutomationIntent(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return false;
    return /(邮件|邮箱|收件箱|mail|email|calendar|日历|日程|会议|提醒|remind|草稿|发送邮件|打开|关闭|启动|切到|前台|音量|静音|睡眠|锁屏|Finder|Safari|微信|WeChat|Terminal|iTerm|System Events)/i.test(text);
  }

  /**
   * Auto-generate a session name using Haiku (async, non-blocking).
   * Writes to Claude's session file (unified with /rename).
   */
  async function autoNameSession(chatId, sessionId, firstPrompt, cwd) {
    try {
      const namePrompt = `Generate a very short session name (2-5 Chinese characters, no punctuation, no quotes) that captures the essence of this user request:

"${firstPrompt.slice(0, 200)}"

Reply with ONLY the name, nothing else. Examples: 插件开发, API重构, Bug修复, 代码审查`;

      const { output } = await spawnClaudeAsync(
        ['-p', '--model', 'haiku'],
        namePrompt,
        HOME,
        15000 // 15s timeout
      );

      if (output) {
        // Clean up: remove quotes, punctuation, trim
        let name = output.replace(/["""''`]/g, '').replace(/[.,!?:;。，！？：；]/g, '').trim();
        // Limit to reasonable length
        if (name.length > 12) name = name.slice(0, 12);
        if (name.length >= 2) {
          // Write to Claude's session file (unified with /rename on desktop)
          writeSessionName(sessionId, cwd, name);
        }
      }
    } catch (e) {
      log('DEBUG', `Auto-name failed for ${sessionId.slice(0, 8)}: ${e.message}`);
    }
  }

  /**
   * Spawn claude as async child process (non-blocking).
   * Returns { output, error } after process exits.
   */
  function spawnClaudeAsync(args, input, cwd, timeoutMs = 300000) {
    return new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...getActiveProviderEnv(),
          CLAUDECODE: undefined,
          METAME_INTERNAL_PROMPT: '1',
        },
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
        }, 5000);
      }, timeoutMs);

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({ output: null, error: 'Timeout: Claude took too long' });
        } else if (code !== 0) {
          resolve({ output: null, error: stderr || `Exit code ${code}` });
        } else {
          resolve({ output: stdout.trim(), error: null });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ output: null, error: err.message });
      });

      // Write input and close stdin
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  /**
   * Tool name to emoji mapping for status display
   */
  const TOOL_EMOJI = {
    Read: '📖',
    Edit: '✏️',
    Write: '📝',
    Bash: '💻',
    Glob: '🔍',
    Grep: '🔎',
    WebFetch: '🌐',
    WebSearch: '🔍',
    Task: '🤖',
    Skill: '🔧',
    TodoWrite: '📋',
    NotebookEdit: '📓',
    default: '🔧',
  };

  /**
   * Spawn claude with streaming output (stream-json mode).
   * Calls onStatus callback when tool usage is detected.
   * Returns { output, error } after process exits.
   */
  function spawnClaudeStreaming(args, input, cwd, onStatus, timeoutMs = 600000, chatId = null) {
    return new Promise((resolve) => {
      // Add stream-json output format (requires --verbose)
      const streamArgs = [...args, '--output-format', 'stream-json', '--verbose'];

      const child = spawn(CLAUDE_BIN, streamArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // Create new process group so killing -pid kills all sub-agents too
        env: { ...process.env, ...getActiveProviderEnv(), CLAUDECODE: undefined },
      });

      // Track active process for /stop
      if (chatId) {
        activeProcesses.set(chatId, { child, aborted: false });
        saveActivePids(); // Fix3: persist PID to disk
      }

      let buffer = '';
      let stderr = '';
      let killed = false;
      let finalResult = '';
      let lastStatusTime = 0;
      const STATUS_THROTTLE = statusThrottleMs;
      const writtenFiles = []; // Track files created/modified by Write tool
      const toolUsageLog = []; // Track all tool invocations for skill evolution

      const timer = setTimeout(() => {
        killed = true;
        log('WARN', `Claude timeout (${timeoutMs / 60000}min) for chatId ${chatId} — killing process group`);
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
        }, 5000);
      }, timeoutMs);

      child.stdout.on('data', (data) => {
        buffer += data.toString();

        // Process complete JSON lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);

            // Extract final result text
            if (event.type === 'assistant' && event.message?.content) {
              const textBlocks = event.message.content.filter(b => b.type === 'text');
              if (textBlocks.length > 0) {
                finalResult = textBlocks.map(b => b.text).join('\n');
              }
            }

            // Detect tool usage and send status
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                  const toolName = block.name || 'Tool';

                  // Track tool usage for skill evolution
                  const toolEntry = { tool: toolName };
                  if (toolName === 'Skill' && block.input?.skill) toolEntry.skill = block.input.skill;
                  else if (block.input?.command) toolEntry.context = block.input.command.slice(0, 50);
                  else if (block.input?.file_path) toolEntry.context = path.basename(block.input.file_path);
                  if (toolUsageLog.length < 50) toolUsageLog.push(toolEntry);

                  // Track files written by Write tool
                  if (toolName === 'Write' && block.input?.file_path) {
                    const filePath = block.input.file_path;
                    if (!writtenFiles.includes(filePath)) {
                      writtenFiles.push(filePath);
                    }
                  }

                  const now = Date.now();
                  if (now - lastStatusTime >= STATUS_THROTTLE) {
                    lastStatusTime = now;
                    const emoji = TOOL_EMOJI[toolName] || TOOL_EMOJI.default;

                    // Resolve display name and context for MCP/Skill/Task tools
                    let displayName = toolName;
                    let displayEmoji = emoji;
                    let context = '';

                    if (toolName === 'Skill' && block.input?.skill) {
                      // Skill invocation: show skill name
                      context = block.input.skill;
                    } else if (toolName === 'Task' && block.input?.description) {
                      // Agent task: show description
                      context = block.input.description.slice(0, 30);
                    } else if (toolName.startsWith('mcp__')) {
                      // MCP tool: mcp__server__action → "MCP server: action"
                      const parts = toolName.split('__');
                      const server = parts[1] || 'unknown';
                      const action = parts.slice(2).join('_') || '';
                      if (server === 'playwright') {
                        displayEmoji = '🌐';
                        displayName = 'Browser';
                        context = action.replace(/_/g, ' ');
                      } else {
                        displayEmoji = '🔗';
                        displayName = `MCP:${server}`;
                        context = action.replace(/_/g, ' ').slice(0, 25);
                      }
                    } else if (block.input) {
                      // Standard tools: extract brief context
                      if (block.input.file_path) {
                        // Insert zero-width space before extension to prevent link parsing
                        const basename = path.basename(block.input.file_path);
                        const dotIdx = basename.lastIndexOf('.');
                        context = dotIdx > 0 ? basename.slice(0, dotIdx) + '\u200B' + basename.slice(dotIdx) : basename;
                      } else if (block.input.command) {
                        context = block.input.command.slice(0, 30);
                        if (block.input.command.length > 30) context += '...';
                      } else if (block.input.pattern) {
                        context = block.input.pattern.slice(0, 20);
                      } else if (block.input.query) {
                        context = block.input.query.slice(0, 25);
                      } else if (block.input.url) {
                        try {
                          context = new URL(block.input.url).hostname;
                        } catch { context = 'web'; }
                      }
                    }

                    const status = context
                      ? `${displayEmoji} ${displayName}: 「${context}」`
                      : `${displayEmoji} ${displayName}...`;

                    if (onStatus) {
                      onStatus(status).catch(() => { });
                    }
                  }
                }
              }
            }

            // Also check for result message type
            if (event.type === 'result' && event.result) {
              finalResult = event.result;
            }
          } catch {
            // Not valid JSON, ignore
          }
        }
      });

      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === 'result' && event.result) {
              finalResult = event.result;
            }
          } catch { /* ignore */ }
        }

        // Clean up active process tracking
        const proc = chatId ? activeProcesses.get(chatId) : null;
        const wasAborted = proc && proc.aborted;
        if (chatId) { activeProcesses.delete(chatId); saveActivePids(); } // Fix3

        if (wasAborted) {
          resolve({ output: finalResult || null, error: 'Stopped by user', files: writtenFiles, toolUsageLog });
        } else if (killed) {
          resolve({ output: finalResult || null, error: 'Timeout: Claude took too long', files: writtenFiles, toolUsageLog });
        } else if (code !== 0) {
          resolve({ output: finalResult || null, error: stderr || `Exit code ${code}`, files: writtenFiles, toolUsageLog });
        } else {
          resolve({ output: finalResult || '', error: null, files: writtenFiles, toolUsageLog });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        if (chatId) { activeProcesses.delete(chatId); saveActivePids(); } // Fix3
        resolve({ output: null, error: err.message, files: [], toolUsageLog: [] });
      });

      // Write input and close stdin
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  // Track outbound message_id → session for reply-based session restoration.
  // Keeps last 200 entries to avoid unbounded growth.
  function trackMsgSession(messageId, session) {
    if (!messageId || !session || !session.id) return;
    const st = loadState();
    if (!st.msg_sessions) st.msg_sessions = {};
    st.msg_sessions[messageId] = { id: session.id, cwd: session.cwd };
    const keys = Object.keys(st.msg_sessions);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete st.msg_sessions[k];
    }
    saveState(st);
  }

  /**
   * Shared ask logic — full Claude Code session (stateful, with tools)
   * Now uses spawn (async) instead of execSync to allow parallel requests.
   */
  async function askClaude(bot, chatId, prompt, config, readOnly = false) {
    log('INFO', `askClaude for ${chatId}: ${prompt.slice(0, 50)}`);
    // Track interaction time for idle/sleep detection
    if (touchInteraction) touchInteraction();
    // Track per-session last_active for summary generation (P2-B)
    try {
      const _st = loadState();
      if (_st.sessions && _st.sessions[chatId]) {
        _st.sessions[chatId].last_active = Date.now();
        saveState(_st);
      }
    } catch { /* non-critical */ }
    // Send a single status message, updated in-place, deleted on completion
    let statusMsgId = null;
    try {
      const msg = await (bot.sendMarkdown ? bot.sendMarkdown(chatId, '🤔') : bot.sendMessage(chatId, '🤔'));
      if (msg && msg.message_id) statusMsgId = msg.message_id;
    } catch (e) {
      log('ERROR', `Failed to send ack to ${chatId}: ${e.message}`);
    }
    await bot.sendTyping(chatId).catch(() => { });
    const typingTimer = setInterval(() => {
      bot.sendTyping(chatId).catch(() => { });
    }, 4000);

    // Agent nickname routing: "贾维斯" / "小美，帮我..." → switch project session
    const agentMatch = routeAgent(prompt, config);
    if (agentMatch) {
      const { key, proj, rest } = agentMatch;
      const projCwd = normalizeCwd(proj.cwd);
      attachOrCreateSession(chatId, projCwd, proj.name || key);
      log('INFO', `Agent switch via nickname: ${key} (${projCwd})`);
      if (!rest) {
        // Pure nickname call — confirm switch and stop
        clearInterval(typingTimer);
        await bot.sendMessage(chatId, `${proj.icon || '🤖'} ${proj.name || key} 在线`);
        return { ok: true };
      }
      // Nickname + content — strip nickname, continue with rest as prompt
      prompt = rest;
    }

    // Skill routing: detect skill first, then decide session
    // BUT: if agent was explicitly addressed by nickname, don't let skill routing hijack the session
    const skill = agentMatch ? null : routeSkill(prompt);
    const chatIdStr = String(chatId);
    const chatAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const boundProjectKey = chatAgentMap[chatIdStr] || projectKeyFromVirtualChatId(chatIdStr);
    const boundProject = boundProjectKey && config.projects ? config.projects[boundProjectKey] : null;
    const boundCwd = (boundProject && boundProject.cwd) ? normalizeCwd(boundProject.cwd) : null;

    // Skills with dedicated pinned sessions (reused across days, no re-injection needed)
    const PINNED_SKILL_SESSIONS = new Set(['skill-manager']);
    const usePinnedSkillSession = !!(skill && PINNED_SKILL_SESSIONS.has(skill));

    let session = getSession(chatId);

    if (usePinnedSkillSession) {
      // Use a dedicated long-lived session per skill
      const state = loadState();
      if (!state.pinned_sessions) state.pinned_sessions = {};
      const pinned = state.pinned_sessions[skill];
      if (pinned) {
        // Reuse existing pinned session
        state.sessions[chatId] = { id: pinned.id, cwd: pinned.cwd, started: true };
        saveState(state);
        session = state.sessions[chatId];
        log('INFO', `Pinned session reused for skill ${skill}: ${pinned.id.slice(0, 8)}`);
      } else {
        // First time — create session and pin it
        session = createSession(chatId, HOME, skill);
        const st2 = loadState();
        if (!st2.pinned_sessions) st2.pinned_sessions = {};
        st2.pinned_sessions[skill] = { id: session.id, cwd: session.cwd };
        saveState(st2);
        log('INFO', `Pinned session created for skill ${skill}: ${session.id.slice(0, 8)}`);
      }
    } else if (!session) {
      if (boundCwd) {
        // Agent-bound chats must stay in their own workspace: never attach to another project's session.
        const recentInBound = listRecentSessions(1, boundCwd);
        if (recentInBound.length > 0 && recentInBound[0].sessionId) {
          const target = recentInBound[0];
          const state = loadState();
          state.sessions[chatId] = {
            id: target.sessionId,
            cwd: boundCwd,
            started: true,
          };
          saveState(state);
          session = state.sessions[chatId];
          log('INFO', `Auto-attached ${chatId} to bound-session: ${target.sessionId.slice(0, 8)} (${path.basename(boundCwd)})`);
        } else {
          session = createSession(chatId, boundCwd, boundProject && boundProject.name ? boundProject.name : '');
          log('INFO', `Created fresh session for bound workspace: ${path.basename(boundCwd)}`);
        }
      } else {
        // Non-bound chats keep legacy behavior: attach global recent, else create.
        const recent = listRecentSessions(1);
        if (recent.length > 0 && recent[0].sessionId && recent[0].projectPath) {
          const target = recent[0];
          const state = loadState();
          state.sessions[chatId] = {
            id: target.sessionId,
            cwd: target.projectPath,
            started: true,
          };
          saveState(state);
          session = state.sessions[chatId];
          log('INFO', `Auto-attached ${chatId} to recent session: ${target.sessionId.slice(0, 8)} (${path.basename(target.projectPath)})`);
        } else {
          session = createSession(chatId);
        }
      }
    }

    // Safety guard: prevent stale state from resuming another workspace's session.
    if (!usePinnedSkillSession && session && session.started && session.id && session.id !== '__continue__' && session.cwd) {
      const sessionCwd = normalizeCwd(session.cwd);
      const existsInCwd = isSessionInCwd(session.id, sessionCwd);
      if (!existsInCwd) {
        log('WARN', `Session mismatch detected for ${chatId}: ${session.id.slice(0, 8)} not found in ${sessionCwd}; creating fresh session`);
        session = createSession(chatId, sessionCwd, boundProject && boundProject.name ? boundProject.name : '');
      }
    }

    // Build claude command
    const args = ['-p'];
    const daemonCfg = loadConfig().daemon || {};
    const model = daemonCfg.model || 'opus';
    args.push('--model', model);
    if (readOnly) {
      // Read-only mode for non-operator users: query/chat only, no write/edit/execute
      const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];
      for (const tool of READ_ONLY_TOOLS) args.push('--allowedTools', tool);
    } else if (daemonCfg.dangerously_skip_permissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      const sessionAllowed = daemonCfg.session_allowed_tools || [];
      for (const tool of sessionAllowed) args.push('--allowedTools', tool);
    }
    if (session.id === '__continue__') {
      args.push('--continue');
    } else if (session.started) {
      args.push('--resume', session.id);
    } else {
      args.push('--session-id', session.id);
    }

    // Memory & Knowledge Injection (RAG)
    let memoryHint = '';
    try {
      const memory = require('./memory');
      const _cid = String(chatId);
      const _cfg = loadConfig();
      const _agentMap = { ...(_cfg.telegram ? _cfg.telegram.chat_agent_map : {}), ...(_cfg.feishu ? _cfg.feishu.chat_agent_map : {}) };
      const projectKey = _agentMap[_cid] || projectKeyFromVirtualChatId(_cid);

      // 1. Inject recent session memories ONLY on first message of a session
      if (!session.started) {
        const recent = memory.recentSessions({ limit: 3, project: projectKey || undefined });
        if (recent.length > 0) {
          const items = recent.map(r => `- [${r.created_at}] ${r.summary}${r.keywords ? ' (keywords: ' + r.keywords + ')' : ''}`).join('\n');
          memoryHint += `\n\n<!-- MEMORY:START -->\n[Session memory - recent context from past sessions, use to inform your responses:\n${items}]\n<!-- MEMORY:END -->`;
        }
      }

      // 2. Dynamic Fact Injection (RAG) — first message only
      // Facts stay in Claude's context for the rest of the session; no need to repeat.
      // Uses QMD hybrid search if available, falls back to FTS5.
      if (!session.started) {
        const searchFn = memory.searchFactsAsync || memory.searchFacts;
        const factQuery = buildFactSearchQuery(prompt, projectKey);
        const facts = await Promise.resolve(searchFn(factQuery, { limit: 5, project: projectKey || undefined }));
        if (facts.length > 0) {
          const factItems = facts.map(f => `- [${f.relation}] ${f.value}`).join('\n');
          memoryHint += `\n\n<!-- FACTS:START -->\n[Relevant knowledge and user preferences retrieved for this query. Follow these constraints implicitly:\n${factItems}]\n<!-- FACTS:END -->`;
          log('INFO', `[MEMORY] Injected ${facts.length} facts (query_len=${factQuery.length})`);
        }
      }

      memory.close();
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') log('WARN', `Memory injection failed: ${e.message}`);
    }

    // Inject daemon hints only on first message of a session
    const daemonHint = !session.started ? `\n\n[System hints - DO NOT mention these to user:
1. Daemon config: The ONLY config is ~/.metame/daemon.yaml (never edit daemon-default.yaml). Auto-reloads on change.
2. File sending: User is on MOBILE. When they ask to see/download a file:
   - Just FIND the file path (use Glob/ls if needed)
   - Do NOT read or summarize the file content (wastes tokens)
   - Add at END of response: [[FILE:/absolute/path/to/file]]
   - Keep response brief: "请查收~! [[FILE:/path/to/file]]"
   - Multiple files: use multiple [[FILE:...]] tags]` : '';

    const routedPrompt = skill ? `/${skill} ${prompt}` : prompt;

    // Mac automation orchestration hint: lets Claude flexibly compose local scripts
    // without forcing users to write slash commands by hand.
    let macAutomationHint = '';
    if (process.platform === 'darwin' && !readOnly && isMacAutomationIntent(prompt)) {
      macAutomationHint = `\n\n[Mac automation policy - do NOT expose this block:
1. Prefer deterministic local control via Bash + osascript/JXA; avoid screenshot/visual workflows unless explicitly requested.
2. Read/query actions can execute directly.
3. Before any side-effect action (send email, create/delete/modify calendar event, delete/move files, app quit, system sleep), first show a short execution preview and require explicit user confirmation.
4. Keep output concise: success/failure + key result only.
5. If permission is missing, guide user to run /mac perms open then retry.]`;
    }

    // P2-B: inject session summary when resuming after a 2h+ gap
    let summaryHint = '';
    if (session.started) {
      try {
        const _stSum = loadState();
        const _sess = _stSum.sessions && _stSum.sessions[chatId];
        if (_sess && _sess.last_summary && _sess.last_summary_at) {
          const _idleMs = Date.now() - (_sess.last_active || 0);
          const _summaryAgeH = (Date.now() - _sess.last_summary_at) / 3600000;
          if (_idleMs > 2 * 60 * 60 * 1000 && _summaryAgeH < 168) {
            summaryHint = `

[上次对话摘要，供参考]: ${_sess.last_summary}`;
            log('INFO', `[DAEMON] Injected session summary for ${chatId} (idle ${Math.round(_idleMs / 3600000)}h)`);
          }
        }
      } catch { /* non-critical */ }
    }

    const fullPrompt = routedPrompt + daemonHint + macAutomationHint + summaryHint + memoryHint;

    // Git checkpoint before Claude modifies files (for /undo)
    // Pass the user prompt as label so checkpoint list is human-readable
    gitCheckpoint(session.cwd, prompt);

    // Use streaming mode to show progress
    // Telegram: edit status msg in-place; Feishu: edit or fallback to new messages
    let editFailed = false;
    let lastFallbackStatus = 0;
    const FALLBACK_THROTTLE = fallbackThrottleMs;
    const onStatus = async (status) => {
      try {
        if (statusMsgId && bot.editMessage && !editFailed) {
          const ok = await bot.editMessage(chatId, statusMsgId, status);
          if (ok !== false) return; // edit succeeded (true or undefined for Telegram)
          editFailed = true; // edit failed, switch to fallback permanently
        }
        // Fallback: send as new message with extra throttle to avoid spam
        const now = Date.now();
        if (now - lastFallbackStatus < FALLBACK_THROTTLE) return;
        lastFallbackStatus = now;
        await bot.sendMessage(chatId, status);
      } catch { /* ignore status update failures */ }
    };

    const { output, error, files, toolUsageLog } = await spawnClaudeStreaming(args, fullPrompt, session.cwd, onStatus, 600000, chatId);
    clearInterval(typingTimer);

    // Skill evolution: capture signal + hot path heuristic check
    if (skillEvolution) {
      try {
        const signal = skillEvolution.extractSkillSignal(fullPrompt, output, error, files, session.cwd, toolUsageLog);
        if (signal) {
          skillEvolution.appendSkillSignal(signal);
          skillEvolution.checkHotEvolution(signal);
        }
      } catch (e) { log('WARN', `Skill evolution signal capture failed: ${e.message}`); }
    }

    // Clean up status message
    if (statusMsgId && bot.deleteMessage) {
      bot.deleteMessage(chatId, statusMsgId).catch(() => { });
    }

    // When Claude completes with no text output (pure tool work), send a done notice
    if (output === '' && !error) {
      // Special case: if dispatch_to was called, send a "forwarded" confirmation
      const dispatchedTargets = (toolUsageLog || [])
        .filter(t => t.tool === 'Bash' && typeof t.context === 'string' && t.context.includes('dispatch_to'))
        .map(t => { const m = t.context.match(/dispatch_to\s+(\S+)/); return m ? m[1] : null; })
        .filter(Boolean);
      if (dispatchedTargets.length > 0) {
        const allProjects = (config && config.projects) || {};
        const names = dispatchedTargets.map(k => (allProjects[k] && allProjects[k].name) || k).join('、');
        const doneMsg = await bot.sendMessage(chatId, `✉️ 已转达给 ${names}，处理中…`);
        if (doneMsg && doneMsg.message_id && session) trackMsgSession(doneMsg.message_id, session);
        const wasNew = !session.started;
        if (wasNew) markSessionStarted(chatId);
        return { ok: true };
      }
      const filesDesc = files && files.length > 0 ? `\n修改了 ${files.length} 个文件` : '';
      const doneMsg = await bot.sendMessage(chatId, `✅ 完成${filesDesc}`);
      if (doneMsg && doneMsg.message_id && session) trackMsgSession(doneMsg.message_id, session);
      const wasNew = !session.started;
      if (wasNew) markSessionStarted(chatId);
      return { ok: true };
    }

    if (output) {
      // Detect provider/model errors disguised as output (e.g., "model not found", API errors)
      const activeProvCheck = providerMod ? providerMod.getActiveName() : 'anthropic';
      const builtinModelsCheck = ['sonnet', 'opus', 'haiku'];
      const looksLikeError = output.length < 300 && /\b(not found|invalid model|unauthorized|401|403|404|error|failed)\b/i.test(output);
      if (looksLikeError && (activeProvCheck !== 'anthropic' || !builtinModelsCheck.includes(model))) {
        log('WARN', `Custom provider/model may have failed (${activeProvCheck}/${model}), output: ${output.slice(0, 200)}`);
        try {
          if (providerMod && activeProvCheck !== 'anthropic') providerMod.setActive('anthropic');
          const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
          if (!cfg.daemon) cfg.daemon = {};
          cfg.daemon.model = 'opus';
          writeConfigSafe(cfg);
          config = loadConfig();
          await bot.sendMessage(chatId, `⚠️ ${activeProvCheck}/${model} 疑似失败，已回退到 anthropic/opus\n输出: ${output.slice(0, 150)}`);
        } catch (fbErr) {
          log('ERROR', `Fallback failed: ${fbErr.message}`);
          await bot.sendMarkdown(chatId, output);
        }
        return { ok: false, error: output };
      }

      // Mark session as started after first successful call
      const wasNew = !session.started;
      if (wasNew) markSessionStarted(chatId);

      const estimated = Math.ceil((prompt.length + output.length) / 4);
      const chatCategory = classifyChatUsage(chatId, {
        projectKey: boundProjectKey || '',
        cwd: session && session.cwd,
        homeDir: HOME,
      });
      recordTokens(loadState(), estimated, { category: chatCategory });

      // Parse [[FILE:...]] markers from output (Claude's explicit file sends)
      const { markedFiles, cleanOutput } = parseFileMarkers(output);

      // Match current session to a project for colored card display
      let activeProject = null;
      if (session && session.cwd && config && config.projects) {
        const sessionCwd = path.resolve(normalizeCwd(session.cwd));
        for (const [, proj] of Object.entries(config.projects)) {
          if (!proj.cwd) continue;
          const projCwd = path.resolve(normalizeCwd(proj.cwd));
          if (sessionCwd === projCwd) { activeProject = proj; break; }
        }
      }

      let replyMsg;
      try {
        if (activeProject && bot.sendCard) {
          replyMsg = await bot.sendCard(chatId, {
            title: `${activeProject.icon || '🤖'} ${activeProject.name || ''}`,
            body: cleanOutput,
            color: activeProject.color || 'blue',
          });
        } else {
          replyMsg = await bot.sendMarkdown(chatId, cleanOutput);
        }
      } catch (sendErr) {
        log('WARN', `sendCard/sendMarkdown failed (${sendErr.message}), falling back to sendMessage`);
        try { replyMsg = await bot.sendMessage(chatId, cleanOutput); } catch (e2) {
          log('ERROR', `sendMessage fallback also failed: ${e2.message}`);
        }
      }
      if (replyMsg && replyMsg.message_id && session) trackMsgSession(replyMsg.message_id, session);

      await sendFileButtons(bot, chatId, mergeFileCollections(markedFiles, files));

      // Auto-name: if this was the first message and session has no name, generate one
      if (wasNew && !getSessionName(session.id)) {
        autoNameSession(chatId, session.id, prompt, session.cwd).catch(() => { });
      }
      return { ok: true };
    } else {
      const errMsg = error || 'Unknown error';
      log('ERROR', `askClaude failed for ${chatId}: ${errMsg.slice(0, 300)}`);

      // If session not found (expired/deleted), create new and retry once
      if (errMsg.includes('not found') || errMsg.includes('No session')) {
        log('WARN', `Session ${session.id} not found, creating new`);
        session = createSession(chatId, session.cwd);

        const retryArgs = ['-p', '--session-id', session.id];
        if (daemonCfg.dangerously_skip_permissions) {
          retryArgs.push('--dangerously-skip-permissions');
        } else {
          const sessionAllowed = daemonCfg.session_allowed_tools || [];
          for (const tool of sessionAllowed) retryArgs.push('--allowedTools', tool);
        }

        const retry = await spawnClaudeStreaming(retryArgs, prompt, session.cwd, onStatus);
        if (retry.output) {
          markSessionStarted(chatId);
          const { markedFiles: retryMarked, cleanOutput: retryClean } = parseFileMarkers(retry.output);
          await bot.sendMarkdown(chatId, retryClean);
          await sendFileButtons(bot, chatId, mergeFileCollections(retryMarked, retry.files));
          return { ok: true };
        } else {
          log('ERROR', `askClaude retry failed: ${(retry.error || '').slice(0, 200)}`);
          try { await bot.sendMessage(chatId, `Error: ${(retry.error || '').slice(0, 200)}`); } catch { /* */ }
          return { ok: false, error: retry.error || errMsg };
        }
      } else if (errMsg === 'Stopped by user' && messageQueue.has(chatId)) {
        // Interrupted by message queue — suppress error, queue timer will handle it
        log('INFO', `Task interrupted by new message for ${chatId}`);
        return { ok: false, error: errMsg, interrupted: true };
      } else {
        // Auto-fallback: if custom provider/model fails, revert to anthropic + opus
        const activeProv = providerMod ? providerMod.getActiveName() : 'anthropic';
        const builtinModels = ['sonnet', 'opus', 'haiku'];
        if (activeProv !== 'anthropic' || !builtinModels.includes(model)) {
          log('WARN', `Custom provider/model failed (${activeProv}/${model}), falling back to anthropic/opus`);
          try {
            if (providerMod && activeProv !== 'anthropic') providerMod.setActive('anthropic');
            const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
            if (!cfg.daemon) cfg.daemon = {};
            cfg.daemon.model = 'opus';
            writeConfigSafe(cfg);
            config = loadConfig();
            await bot.sendMessage(chatId, `⚠️ ${activeProv}/${model} 失败，已回退到 anthropic/opus\n原因: ${errMsg.slice(0, 100)}`);
          } catch (fallbackErr) {
            log('ERROR', `Fallback failed: ${fallbackErr.message}`);
            try { await bot.sendMessage(chatId, `Error: ${errMsg.slice(0, 200)}`); } catch { /* */ }
          }
        } else {
          try { await bot.sendMessage(chatId, `Error: ${errMsg.slice(0, 200)}`); } catch { /* */ }
        }
        return { ok: false, error: errMsg };
      }
    }

    return { ok: true };
  }

  return {
    parseFileMarkers,
    mergeFileCollections,
    spawnClaudeAsync,
    spawnClaudeStreaming,
    trackMsgSession,
    askClaude,
  };
}

module.exports = { createClaudeEngine };

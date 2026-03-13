'use strict';

const { createCommandSessionResolver } = require('./daemon-command-session-route');

function createOpsCommandHandler(deps) {
  const {
    fs,
    path,
    spawn,
    execSync,
    log,
    loadConfig,
    loadState,
    messageQueue,
    activeProcesses,
    getSession,
    getSessionForEngine,
    listCheckpoints,
    cpDisplayLabel,
    truncateSessionToCheckpoint,
    findSessionFile,
    clearSessionFileCache,
    cpExtractTimestamp,
    gitCheckpoint,
    cleanupCheckpoints,
    getNoSleepProcess,
    setNoSleepProcess,
    getDefaultEngine = () => 'claude',
  } = deps;
  const { getActiveSession } = createCommandSessionResolver({
    path,
    loadConfig,
    loadState,
    getSession,
    getSessionForEngine,
    getDefaultEngine,
  });

  function clearMessageQueue(chatId) {
    if (messageQueue.has(chatId)) {
      const q = messageQueue.get(chatId);
      if (q.timer) clearTimeout(q.timer);
      messageQueue.delete(chatId);
    }
  }

  function interruptActiveProcess(chatId) {
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      try { process.kill(-proc.child.pid, 'SIGINT'); } catch { proc.child.kill('SIGINT'); }
    }
  }

  async function handleOpsCommand(ctx) {
    const { bot, chatId, text } = ctx;

    if (text === '/undo' || text.startsWith('/undo ')) {
      clearMessageQueue(chatId);
      interruptActiveProcess(chatId);

      const { session } = getActiveSession(chatId);
      if (!session || !session.id) {
        await bot.sendMessage(chatId, 'No active session to undo.');
        return true;
      }

      const cwd = session.cwd;
      const arg = text.slice(5).trim();

      // /undo <hash> — git reset to specific checkpoint (advanced usage)
      if (arg) {
        if (!cwd) {
          await bot.sendMessage(chatId, '❌ 当前 session 无工作目录，无法执行 git undo');
          return true;
        }
        let isGitRepo = false;
        try { execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore', timeout: 3000, ...(process.platform === 'win32' ? { windowsHide: true } : {}) }); isGitRepo = true; } catch { }
        const checkpoints = isGitRepo ? listCheckpoints(cwd) : [];
        const match = checkpoints.find(cp => cp.hash.startsWith(arg));
        if (!match) {
          await bot.sendMessage(chatId, `❌ 未找到 checkpoint: ${arg}`);
          return true;
        }
        try {
          let diffFiles = '';
          const _wh = process.platform === 'win32' ? { windowsHide: true } : {};
          try { diffFiles = execSync(`git diff --name-only HEAD ${match.hash}`, { cwd, encoding: 'utf8', timeout: 5000, ..._wh }).trim(); } catch { }
          execSync(`git reset --hard ${match.hash}`, { cwd, stdio: 'ignore', timeout: 10000, ..._wh });
          // Truncate context to checkpoint time (covers multi-turn rollback)
          truncateSessionToCheckpoint(session.id, match.message);
          const fileList = diffFiles ? diffFiles.split('\n').map(f => path.basename(f)).join(', ') : '';
          const fileCount = diffFiles ? diffFiles.split('\n').length : 0;
          let msg = `⏪ 已回退到 ${cpDisplayLabel(match.message)}`;
          if (fileCount > 0) msg += `\n📁 ${fileCount} 个文件恢复: ${fileList}`;
          log('INFO', `/undo <hash> executed for ${chatId}: reset to ${match.hash.slice(0, 8)}, files=${fileCount}`);
          await bot.sendMessage(chatId, msg);
          cleanupCheckpoints(cwd);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Undo failed: ${e.message}`);
        }
        return true;
      }

      // /undo (no arg) — show recent user messages as buttons to pick rollback point
      try {
        const sessionFile = findSessionFile(session.id);
        if (!sessionFile) {
          await bot.sendMessage(chatId, '⚠️ 找不到 session 文件，无法列出历史消息');
          return true;
        }
        const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(l => l.trim());

        // Helper: extract real user text (skip tool_result entries and system annotations)
        const extractUserText = (obj) => {
          try {
            const content = obj.message?.content;
            if (typeof content === 'string') return content.trim();
            if (Array.isArray(content)) {
              // Skip entries that are purely tool results
              if (content.every(c => c.type === 'tool_result')) return '';
              // Find first text item that isn't a system annotation (exact patterns only)
              const SYSTEM_ANNOTATION = /^\[(Image source|Pasted|Attachment|File):/;
              const item = content.find(c => c.type === 'text' && c.text && !SYSTEM_ANNOTATION.test(c.text));
              return item?.text?.trim() || '';
            }
          } catch { }
          return '';
        };

        // Collect only real human-written user messages (skip tool results / annotations)
        const userMsgs = [];
        for (let i = 0; i < lines.length; i++) {
          try {
            const obj = JSON.parse(lines[i]);
            if (obj.type === 'user' && obj.message?.role === 'user') {
              const msgText = extractUserText(obj);
              if (msgText) userMsgs.push({ idx: i, obj, text: msgText });
            }
          } catch { }
        }
        if (userMsgs.length === 0) {
          await bot.sendMessage(chatId, '⚠️ 没有可回退的历史消息');
          return true;
        }

        // Show last 10 (most recent first)
        const recent = userMsgs.slice(-10).reverse();
        if (bot.sendButtons) {
          const buttons = recent.map(({ idx, text: msgText, obj }) => {
            const label = msgText.replace(/\n/g, ' ').slice(0, 28);
            let timeLabel = '';
            if (obj.timestamp) {
              const d = new Date(obj.timestamp);
              if (!isNaN(d)) timeLabel = ` (${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`;
            }
            return [{ text: `⏪ ${label}${timeLabel}`, callback_data: `/undo_to ${idx}` }];
          });
          await bot.sendButtons(chatId, `↩️ 回退到哪条消息之前？(共 ${userMsgs.length} 轮)`, buttons);
        } else {
          let msg = '回退到哪条消息之前？回复 /undo_to <序号>\n\n';
          recent.forEach(({ idx, text: msgText }) => {
            msg += `[${idx}] ${msgText.slice(0, 40)}\n`;
          });
          await bot.sendMessage(chatId, msg);
        }
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Undo failed: ${e.message}`);
      }
      return true;
    }

    // /undo_to <lineIdx> — restore session to before the message at given JSONL line index
    if (text.startsWith('/undo_to ')) {
      const idx = parseInt(text.slice(9).trim(), 10);
      if (isNaN(idx) || idx < 0) {
        await bot.sendMessage(chatId, '❌ 无效的回退序号');
        return true;
      }

      // Kill any running task
      clearMessageQueue(chatId);
      interruptActiveProcess(chatId);

      const { session: session2 } = getActiveSession(chatId);
      if (!session2 || !session2.id) {
        await bot.sendMessage(chatId, 'No active session.');
        return true;
      }

      try {
        const sessionFile2 = findSessionFile(session2.id);
        if (!sessionFile2) { await bot.sendMessage(chatId, '❌ 找不到 session 文件'); return true; }

        const lines2 = fs.readFileSync(sessionFile2, 'utf8').split('\n').filter(l => l.trim());
        if (idx >= lines2.length) {
          await bot.sendMessage(chatId, '❌ 序号超出范围，session 已变化，请重新 /undo');
          return true;
        }

        // Get target message text + timestamp for display and git matching
        let targetMsg = '';
        let targetTs = 0;
        try {
          const obj = JSON.parse(lines2[idx]);
          const content = obj.message?.content;
          if (typeof content === 'string') targetMsg = content;
          else if (Array.isArray(content)) targetMsg = content.find(c => c.type === 'text')?.text || '';
          if (obj.timestamp) targetTs = new Date(obj.timestamp).getTime() || 0;
        } catch { }

        // Git reset first (before JSONL truncation) so failure leaves state consistent
        let gitMsg2 = '';
        const cwd2 = session2.cwd;
        if (cwd2) {
          let isGitRepo2 = false;
          try { execSync('git rev-parse --is-inside-work-tree', { cwd: cwd2, stdio: 'ignore', timeout: 3000, ...(process.platform === 'win32' ? { windowsHide: true } : {}) }); isGitRepo2 = true; } catch { }
          if (isGitRepo2) {
            // Exclude safety checkpoints from matching to avoid confusion
            const checkpoints2 = listCheckpoints(cwd2).filter(cp => !cp.message.includes('[metame-safety]'));
            const cpMatch = targetTs
              ? checkpoints2.find(cp => { const t = new Date(cpExtractTimestamp(cp.message) || 0).getTime(); return t > 0 && t <= targetTs; })
              : checkpoints2[0];
            if (cpMatch) {
              let diffFiles2 = '';
              const _wh2 = process.platform === 'win32' ? { windowsHide: true } : {};
              try { diffFiles2 = execSync(`git diff --name-only HEAD ${cpMatch.hash}`, { cwd: cwd2, encoding: 'utf8', timeout: 5000, ..._wh2 }).trim(); } catch { }
              if (diffFiles2) {
                // Save current state with distinct prefix (excluded from normal /undo list)
                gitCheckpoint(cwd2, `[metame-safety] before rollback to: ${targetMsg.slice(0, 40)}`);
                execSync(`git reset --hard ${cpMatch.hash}`, { cwd: cwd2, stdio: 'ignore', timeout: 10000, ..._wh2 });
                gitMsg2 = `\n📁 ${diffFiles2.split('\n').length} 个文件已恢复`;
                cleanupCheckpoints(cwd2);
              }
            }
          }
        }

        // Truncate JSONL after git reset succeeds
        const kept2 = lines2.slice(0, idx);
        fs.writeFileSync(sessionFile2, kept2.length ? kept2.join('\n') + '\n' : '', 'utf8');
        clearSessionFileCache(session2.id);
        const removed2 = lines2.length - kept2.length;

        const preview = targetMsg.replace(/\n/g, ' ').slice(0, 30) || `行 ${idx}`;
        log('INFO', `/undo_to ${idx} for ${chatId}: removed=${removed2} lines${gitMsg2 ? ', ' + gitMsg2.trim() : ''}`);
        await bot.sendMessage(chatId, `⏪ 已回退到「${preview}」之前\n🧠 上下文回滚 ${removed2} 行${gitMsg2}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 回退失败: ${e.message}`);
      }
      return true;
    }

    if (text === '/nosleep') {
      if (process.platform !== 'darwin') {
        await bot.sendMessage(chatId, '❌ /nosleep 仅支持 macOS');
        return true;
      }
      if (getNoSleepProcess()) {
        // Turn off — kill caffeinate
        try { getNoSleepProcess().kill(); } catch { /* already dead */ }
        setNoSleepProcess(null);
        log('INFO', 'Caffeinate stopped — system sleep re-enabled');
        await bot.sendMessage(chatId, '😴 已关闭防睡眠，系统恢复正常休眠');
      } else {
        // Turn on — spawn caffeinate (prevent display+idle+system sleep)
        try {
          const p = spawn('caffeinate', ['-dis'], {
            detached: true,
            stdio: 'ignore',
          });
          p.unref();
          p.on('exit', () => { setNoSleepProcess(null); });
          setNoSleepProcess(p);
          log('INFO', 'Caffeinate started — preventing system sleep');
          await bot.sendMessage(chatId, '☕ 防睡眠已开启，合盖不休眠\n再次 /nosleep 关闭');
        } catch (e) {
          log('ERROR', `Failed to start caffeinate: ${e.message}`);
          await bot.sendMessage(chatId, `❌ 启动失败: ${e.message}`);
        }
      }
      return true;
    }

    return false;
  }

  return { handleOpsCommand };
}

module.exports = { createOpsCommandHandler };

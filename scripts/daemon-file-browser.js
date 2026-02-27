'use strict';

function createFileBrowser(deps) {
  const {
    fs,
    path,
    HOME,
    shortenPath,
    expandPath,
  } = deps;

  const CONTENT_EXTENSIONS = new Set([
    '.md', '.txt', '.rtf',
    '.doc', '.docx', '.pdf', '.odt',
    '.wav', '.mp3', '.m4a', '.ogg', '.flac',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
    '.mp4', '.mov', '.avi', '.webm',
    '.csv', '.xlsx', '.xls',
    '.html', '.htm',
  ]);

  const fileCache = new Map();
  const FILE_CACHE_TTL = 1800000; // 30 minutes

  const DIR_LIST_TYPE_EMOJI = {
    '.md': '📄', '.txt': '📄', '.pdf': '📕',
    '.js': '⚙️', '.ts': '⚙️', '.py': '🐍', '.json': '📋', '.yaml': '📋', '.yml': '📋',
    '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️', '.webp': '🖼️',
    '.wav': '🎵', '.mp3': '🎵', '.m4a': '🎵', '.flac': '🎵',
    '.mp4': '🎬', '.mov': '🎬',
    '.csv': '📊', '.xlsx': '📊',
    '.html': '🌐', '.css': '🎨',
    '.sh': '💻', '.bash': '💻',
  };

  function normalizeCwd(p) {
    return expandPath(p).replace(/^~/, HOME);
  }

  function isContentFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return CONTENT_EXTENSIONS.has(ext);
  }

  function cacheFile(filePath) {
    const shortId = Math.random().toString(36).slice(2, 10);
    fileCache.set(shortId, { path: filePath, expires: Date.now() + FILE_CACHE_TTL });
    return shortId;
  }

  function getCachedFile(shortId) {
    const entry = fileCache.get(shortId);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
      fileCache.delete(shortId);
      return null;
    }
    return entry.path;
  }

  async function sendFileButtons(bot, chatId, files) {
    if (!bot.sendButtons || files.size === 0) return;
    const validFiles = [...files].filter(f => fs.existsSync(f));
    if (validFiles.length === 0) return;
    const buttons = validFiles.map(filePath => {
      const shortId = cacheFile(filePath);
      return [{ text: `📎 ${path.basename(filePath)}`, callback_data: `/file ${shortId}` }];
    });
    await bot.sendButtons(chatId, '📂 文件:', buttons);
  }

  async function sendDirPicker(bot, chatId, mode, title) {
    await sendBrowse(bot, chatId, mode, HOME, title);
  }

  async function sendBrowse(bot, chatId, mode, dirPath, title, page = 0) {
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) throw new Error('Not a directory');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
      const parent = path.dirname(dirPath);
      const displayPath = dirPath.replace(HOME, '~');

      const cmd = mode === 'new' ? '/new'
        : mode === 'bind' ? '/agent-bind-dir'
        : mode === 'agent-new' ? '/agent-dir'
        : '/cd';

      const PAGE_SIZE = 10;
      const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
      const safePage = Math.max(0, Math.min(page, totalPages - 1));
      const start = safePage * PAGE_SIZE;
      const pageSubdirs = entries.slice(start, start + PAGE_SIZE);

      if (bot.sendButtons) {
        const buttons = [];
        buttons.push([{ text: `✓ 选择「${displayPath}」`, callback_data: `${cmd} ${shortenPath(dirPath)}` }]);
        for (const name of pageSubdirs) {
          const full = path.join(dirPath, name);
          buttons.push([{ text: `📁 ${name}`, callback_data: `/browse ${mode} ${shortenPath(full)}` }]);
        }
        const nav = [];
        if (safePage > 0) nav.push({ text: '← 上页', callback_data: `/browse ${mode} ${shortenPath(dirPath)} ${safePage - 1}` });
        if (safePage < totalPages - 1) nav.push({ text: '下页 →', callback_data: `/browse ${mode} ${shortenPath(dirPath)} ${safePage + 1}` });
        if (nav.length) buttons.push(nav);
        if (parent !== dirPath) {
          buttons.push([{ text: '⬆ 上级目录', callback_data: `/browse ${mode} ${shortenPath(parent)}` }]);
        }
        const header = title ? `${title}\n📂 ${displayPath}` : `📂 ${displayPath}`;
        await bot.sendButtons(chatId, header, buttons);
      } else {
        let msg = `📂 ${displayPath}\n\n`;
        pageSubdirs.forEach((name, i) => {
          msg += `${safePage * PAGE_SIZE + i + 1}. ${name}/\n   /browse ${mode} ${path.join(dirPath, name)}\n`;
        });
        msg += `\n✓ 选择此目录: ${cmd} ${dirPath}`;
        if (parent !== dirPath) msg += `\n⬆ 上级: /browse ${mode} ${parent}`;
        await bot.sendMessage(chatId, msg);
      }
    } catch {
      await bot.sendMessage(chatId, `无法读取目录: ${dirPath}`);
    }
  }

  async function sendDirListing(bot, chatId, baseDir, arg) {
    let targetDir = baseDir;
    let globFilter = null;

    if (arg) {
      if (arg.includes('*')) {
        globFilter = arg;
      } else {
        const sub = path.resolve(baseDir, arg);
        if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
          targetDir = sub;
        } else {
          await bot.sendMessage(chatId, `❌ Not found: ${arg}`);
          return;
        }
      }
    }

    try {
      let entries = fs.readdirSync(targetDir, { withFileTypes: true });
      if (globFilter) {
        const pattern = globFilter.replace(/\./g, '\\.').replace(/\*/g, '.*');
        const re = new RegExp('^' + pattern + '$', 'i');
        entries = entries.filter(e => re.test(e.name));
      }
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
      entries = entries.filter(e => !e.name.startsWith('.'));

      if (entries.length === 0) {
        await bot.sendMessage(chatId, `📁 ${path.basename(targetDir)}/\n(empty)`);
        return;
      }

      const allButtons = [];
      const MAX_BUTTONS = 20;

      for (const entry of entries.slice(0, MAX_BUTTONS)) {
        const fullPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
          const cbPath = fullPath.length <= 58 ? fullPath : shortenPath(fullPath);
          allButtons.push([{ text: `📂 ${entry.name}/`, callback_data: `/list ${cbPath}` }]);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const emoji = DIR_LIST_TYPE_EMOJI[ext] || '📎';
          let size = '';
          try {
            const stat = fs.statSync(fullPath);
            const bytes = stat.size;
            if (bytes < 1024) size = ` ${bytes}B`;
            else if (bytes < 1048576) size = ` ${(bytes / 1024).toFixed(0)}KB`;
            else size = ` ${(bytes / 1048576).toFixed(1)}MB`;
          } catch { /* ignore */ }
          if (isContentFile(fullPath)) {
            const shortId = cacheFile(fullPath);
            allButtons.push([{ text: `${emoji} ${entry.name}${size}`, callback_data: `/file ${shortId}` }]);
          } else {
            allButtons.push([{ text: `${emoji} ${entry.name}${size}`, callback_data: 'noop' }]);
          }
        }
      }

      const header = `📁 ${path.basename(targetDir)}/` + (entries.length > MAX_BUTTONS ? ` (${MAX_BUTTONS}/${entries.length})` : '');
      if (allButtons.length > 0 && bot.sendButtons) {
        await bot.sendButtons(chatId, header, allButtons);
      } else {
        const lines = [header];
        for (const entry of entries.slice(0, MAX_BUTTONS)) {
          const isDir = entry.isDirectory();
          lines.push(isDir ? `  📂 ${entry.name}/` : `  📎 ${entry.name}`);
        }
        await bot.sendMessage(chatId, lines.join('\n'));
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ ${e.message}`);
    }
  }

  return {
    normalizeCwd,
    isContentFile,
    getCachedFile,
    sendFileButtons,
    sendDirPicker,
    sendBrowse,
    sendDirListing,
  };
}

module.exports = { createFileBrowser };

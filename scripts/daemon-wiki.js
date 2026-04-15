'use strict';

/**
 * daemon-wiki.js — /wiki command handler
 *
 * Subcommands (Phase 1):
 *   /wiki                     — list all wiki pages (title, staleness, last_built)
 *   /wiki research <query>    — search wiki + facts, format answer (trackSearch: true)
 *   /wiki page <slug>         — show full content of a page
 *   /wiki sync                — force rebuild stale pages (staleness ≥ 0.4)
 *   /wiki pin <tag> [title]   — manually register a topic (force=true, pinned=1)
 *   /wiki open                — open Obsidian vault
 *
 * Exports:
 *   createWikiCommandHandler(deps) → { handleWikiCommand }
 */

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  listWikiPages,
  getWikiPageBySlug,
  searchWikiAndFacts,
  upsertWikiTopic,
} = require('./core/wiki-db');

const STALENESS_THRESHOLD = 0.4;
const DEFAULT_WIKI_DIR = path.join(os.homedir(), 'Documents', 'MetaMe-Wiki');

function createWikiCommandHandler(deps) {
  const {
    getDb,                    // () → DatabaseSync
    providers,                // { callHaiku, buildDistillEnv }
    wikiOutputDir,            // optional — path to Obsidian vault wiki folder
    log = () => {},
  } = deps;

  const outputDir = wikiOutputDir || DEFAULT_WIKI_DIR;

  /**
   * Main entry point. Returns true if /wiki command was handled.
   * @param {{ bot: object, chatId: string, text: string }} ctx
   * @returns {Promise<boolean>}
   */
  async function handleWikiCommand(ctx) {
    const { bot, chatId, text } = ctx;
    if (typeof text !== 'string') return false;

    const trimmed = text.trim();
    if (trimmed === '/wiki') {
      await _handleList(bot, chatId);
      return true;
    }
    if (trimmed === '/wiki research' || trimmed.startsWith('/wiki research ')) {
      const query = trimmed.slice(15).trim();
      await _handleResearch(bot, chatId, query);
      return true;
    }
    if (trimmed === '/wiki page' || trimmed.startsWith('/wiki page ')) {
      const slug = trimmed.slice(11).trim();
      await _handlePage(bot, chatId, slug);
      return true;
    }
    if (trimmed === '/wiki sync') {
      await _handleSync(bot, chatId);
      return true;
    }
    if (trimmed === '/wiki pin' || trimmed.startsWith('/wiki pin ')) {
      const args = trimmed.slice(10).trim();
      await _handlePin(bot, chatId, args);
      return true;
    }
    if (trimmed === '/wiki open') {
      await _handleOpen(bot, chatId);
      return true;
    }
    if (trimmed === '/wiki help' || trimmed === '/wiki ?') {
      await _handleHelp(bot, chatId);
      return true;
    }
    if (trimmed === '/wiki import' || trimmed.startsWith('/wiki import ')) {
      const args = trimmed.slice(12).trim();
      await _handleImport(bot, chatId, args);
      return true;
    }
    // Unknown /wiki subcommand — show help
    if (trimmed.startsWith('/wiki ')) {
      await _handleHelp(bot, chatId);
      return true;
    }

    return false;
  }

  // ── Subcommand handlers ──────────────────────────────────────────────────────

  async function _handleList(bot, chatId) {
    const db = getDb();
    const pages = listWikiPages(db, { limit: 50, orderBy: 'title' });

    if (pages.length === 0) {
      await bot.sendMessage(chatId,
        '📚 Wiki 暂无页面。\n\n使用 `/wiki pin <标签> [标题]` 手工注册第一个主题。'
      );
      return;
    }

    const lines = ['📚 **知识 Wiki**', ''];
    for (const p of pages) {
      const stalePct = Math.round((p.staleness || 0) * 100);
      const built = p.last_built_at ? p.last_built_at.slice(0, 10) : '未建';
      const staleFlag = p.staleness >= STALENESS_THRESHOLD ? ' ⚠️' : '';
      lines.push(`• **${p.title}** \`${p.slug}\`${staleFlag}`);
      lines.push(`  来源:${p.raw_source_count || 0} 条 · 陈旧度:${stalePct}% · 更新:${built}`);
    }
    lines.push('');
    lines.push(`共 ${pages.length} 页 · \`/wiki research <关键词>\` 搜索`);

    await bot.sendMessage(chatId, lines.join('\n'));
  }

  async function _handleResearch(bot, chatId, query) {
    if (!query) {
      await bot.sendMessage(chatId, '用法: `/wiki research <关键词>`');
      return;
    }

    const db = getDb();
    let wikiPages, facts;
    try {
      const { hybridSearchWiki } = require('./core/hybrid-search');
      ({ wikiPages, facts } = await hybridSearchWiki(db, query, { trackSearch: true }));
    } catch (err) {
      log('WARN', `[wiki-research] hybrid search fallback to FTS: ${err.message}`);
      ({ wikiPages, facts } = searchWikiAndFacts(db, query, { trackSearch: true }));
    }

    if (wikiPages.length === 0 && facts.length === 0) {
      await bot.sendMessage(chatId,
        `🔍 未找到与「${query}」相关的知识。\n\n可用 \`/wiki pin ${query}\` 手工注册主题，或等待记忆积累后自动建页。`
      );
      return;
    }

    const lines = [`🔍 **「${query}」相关知识**`, ''];

    for (const wp of wikiPages.slice(0, 3)) {
      const built = wp.last_built_at ? wp.last_built_at.slice(0, 10) : '—';
      lines.push(`📖 **${wp.title}**`);
      if (wp.excerpt) lines.push(wp.excerpt.replace(/<\/?b>/g, '**'));
      lines.push(`来源: \`${wp.slug}\` · 更新于 ${built}`);
      lines.push('');
    }

    if (facts.length > 0) {
      lines.push(`📌 **相关事实** (${facts.length} 条)`);
      for (const f of facts.slice(0, 5)) {
        const title = f.title ? `**${f.title}** ` : '';
        const excerpt = f.excerpt
          ? f.excerpt.replace(/<\/?b>/g, '**').slice(0, 120)
          : (f.content || '').slice(0, 120);
        lines.push(`• ${title}${excerpt}`);
      }
    }

    await bot.sendMessage(chatId, lines.join('\n'));
  }

  async function _handlePage(bot, chatId, slug) {
    if (!slug) {
      await bot.sendMessage(chatId, '用法: `/wiki page <slug>`');
      return;
    }

    const db = getDb();
    const page = getWikiPageBySlug(db, slug);

    if (!page) {
      await bot.sendMessage(chatId, `❌ 未找到页面 \`${slug}\`\n\n用 \`/wiki\` 查看所有页面。`);
      return;
    }

    const built = page.last_built_at ? page.last_built_at.slice(0, 10) : '未建';
    const stalePct = Math.round((page.staleness || 0) * 100);

    const lines = [
      `📄 **${page.title}**`,
      `_标签: ${page.primary_topic} · 来源: ${page.raw_source_count || 0} 条 · 陈旧度: ${stalePct}% · 更新: ${built}_`,
      '',
      page.content,
    ];

    await bot.sendMessage(chatId, lines.join('\n'));
  }

  async function _handleSync(bot, chatId) {
    const db = getDb();
    const pages = listWikiPages(db, { limit: 200 });
    const staleCount = pages.filter(p => (p.staleness || 0) >= STALENESS_THRESHOLD).length;

    if (staleCount === 0) {
      await bot.sendMessage(chatId, `✅ Wiki 已是最新状态，无需重建。`);
      return;
    }

    await bot.sendMessage(chatId, `🔄 开始重建 ${staleCount} 个陈旧页面...`);

    try {
      const { runWikiReflect } = require('./wiki-reflect');
      const result = await runWikiReflect(db, {
        providers,
        outputDir,
        threshold: STALENESS_THRESHOLD,
      });

      const lines = ['✅ Wiki 重建完成'];
      if (result.built.length > 0) {
        lines.push(`• 重建: ${result.built.join(', ')}`);
        try {
          const { execFile } = require('child_process');
          const embScript = path.join(os.homedir(), '.metame', 'daemon-embedding.js');
          execFile('node', [embScript], { timeout: 120000, stdio: 'ignore' }, (err) => {
            if (err) log('WARN', `[wiki-sync] embedding trigger failed: ${err.message}`);
          });
        } catch { }
      }
      if (result.failed.length > 0) {
        lines.push(`• 失败: ${result.failed.map(f => f.slug).join(', ')}`);
      }
      if (result.exportFailed.length > 0) {
        lines.push(`• 文件导出失败 (DB 已更新): ${result.exportFailed.join(', ')}`);
      }
      await bot.sendMessage(chatId, lines.join('\n'));

      // Phased doc + cluster rebuild (wiki-import feature extension)
      const { listStaleDocSources } = require('./core/wiki-db');
      const { buildDocWikiPage } = require('./wiki-reflect-build');
      const { extractText } = require('./wiki-extract');
      const allDocSlugsForSync = db.prepare("SELECT slug FROM doc_sources WHERE status='active'").all().map(r => r.slug);
      const staleDocSources = listStaleDocSources(db);
      const builtDocSlugs = [];
      for (const docSrc of staleDocSources) {
        try {
          const { text } = await extractText(docSrc.file_path);
          const docResult = await buildDocWikiPage(db, docSrc, text, { allowedSlugs: allDocSlugsForSync, providers });
          if (docResult) {
            db.prepare("UPDATE doc_sources SET content_stale=0, built_at=? WHERE id=?")
              .run(new Date().toISOString(), docSrc.id);
            builtDocSlugs.push(docSrc.slug);
          }
        } catch (docErr) {
          db.prepare("UPDATE doc_sources SET error_message=? WHERE id=?").run(docErr.message, docSrc.id);
          log('WARN', `[wiki-sync] doc rebuild failed ${docSrc.slug}: ${docErr.message}`);
        }
      }
      // Cascade stale cluster pages
      if (builtDocSlugs.length > 0) {
        const ph = builtDocSlugs.map(() => '?').join(',');
        const affected = db.prepare(`SELECT DISTINCT page_slug FROM wiki_page_doc_sources
          WHERE role='cluster_member' AND doc_source_id IN
          (SELECT id FROM doc_sources WHERE slug IN (${ph}))`).all(...builtDocSlugs).map(r => r.page_slug);
        if (affected.length) {
          db.prepare(`UPDATE wiki_pages SET staleness=1 WHERE slug IN (${affected.map(() => '?').join(',')})`).run(...affected);
        }
      }
      // Rebuild stale cluster pages after embedding drain
      const { waitForEmbeddingDrain } = require('./wiki-import');
      const phase1ChunkIds = builtDocSlugs.flatMap(slug =>
        db.prepare("SELECT id FROM content_chunks WHERE page_slug=?").all(slug).map(c => c.id)
      );
      const drainedOk = await waitForEmbeddingDrain(db, phase1ChunkIds, (msg) => log('INFO', msg));
      if (drainedOk) {
        const { buildTopicClusterPage } = require('./wiki-reflect-build');
        const { getClusterMemberIds } = require('./core/wiki-db');
        const staleClusterPages = db.prepare("SELECT * FROM wiki_pages WHERE source_type='topic_cluster' AND staleness=1").all();
        for (const cp of staleClusterPages) {
          const memberIds = getClusterMemberIds(db, cp.slug);
          const getDocSrcById = db.prepare("SELECT * FROM doc_sources WHERE id=?");
          const docRows = memberIds.map(id => getDocSrcById.get(id)).filter(Boolean);
          try {
            await buildTopicClusterPage(db, docRows, { allowedSlugs: allDocSlugsForSync, providers, existingClusters: [] });
          } catch (clErr) {
            log('WARN', `[wiki-sync] cluster rebuild failed ${cp.slug}: ${clErr.message}`);
          }
        }
      }
      if (staleDocSources.length > 0) {
        const docMsg = [];
        if (builtDocSlugs.length > 0) docMsg.push(`• 文档页面重建: ${builtDocSlugs.join(', ')}`);
        const docFailed = staleDocSources.length - builtDocSlugs.length;
        if (docFailed > 0) docMsg.push(`• 文档重建失败: ${docFailed} 个（见日志）`);
        if (docMsg.length > 0) {
          await bot.sendMessage(chatId, `📄 文档页面同步\n\n${docMsg.join('\n')}`);
        }
      }
    } catch (err) {
      log('ERROR', `[wiki-sync] ${err.message}`);
      if (err.message.includes('another instance')) {
        await bot.sendMessage(chatId, '⚠️ Wiki 重建正在进行中，请稍后再试。');
      } else {
        await bot.sendMessage(chatId, `❌ Wiki 重建失败: ${err.message}`);
      }
    }
  }

  async function _handlePin(bot, chatId, args) {
    if (!args) {
      await bot.sendMessage(chatId, '用法: `/wiki pin <标签> [显示名称]`\n例: `/wiki pin session Session管理`');
      return;
    }

    // Parse: first token = tag, rest = label
    const parts = args.split(/\s+/);
    const tag = parts[0];
    const label = parts.slice(1).join(' ') || tag;

    const db = getDb();
    try {
      const { slug, isNew } = upsertWikiTopic(db, tag, { label, pinned: 1, force: true });
      if (isNew) {
        await bot.sendMessage(chatId,
          `📌 已注册主题 \`${tag}\` (slug: \`${slug}\`)\n\n使用 \`/wiki sync\` 构建页面，或等待每周自动重建。`
        );
      } else {
        await bot.sendMessage(chatId,
          `📌 主题 \`${tag}\` 已更新标题为「${label}」，pinned=1。`
        );
      }
    } catch (err) {
      log('ERROR', `[wiki-pin] ${err.message}`);
      await bot.sendMessage(chatId, `❌ 注册失败: ${err.message}`);
    }
  }

  async function _handleOpen(bot, chatId) {
    try {
      // Ensure the vault directory exists (may not yet have any pages)
      const fs = require('fs');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      // Try Obsidian URI first (opens vault by path if already configured)
      const vaultName = path.basename(outputDir);
      try {
        execFileSync('open', [`obsidian://open?vault=${encodeURIComponent(vaultName)}`], { timeout: 5000 });
      } catch {
        // Fallback: open folder in Finder — user can then drag into Obsidian
        execFileSync('open', [outputDir], { timeout: 5000 });
      }
      await bot.sendMessage(chatId,
        `📂 已打开 Obsidian vault: \`${outputDir}\`\n\n` +
        `如果是第一次打开，请在 Obsidian 里选 **Open folder as vault** 并选择该目录。\n` +
        `之后用 \`/wiki sync\` 生成页面。`
      );
    } catch (err) {
      log('ERROR', `[wiki-open] ${err.message}`);
      await bot.sendMessage(chatId, `❌ 打开失败: ${err.message}\n\nVault 路径: \`${outputDir}\``);
    }
  }

  async function _handleImport(bot, chatId, args) {
    const noCluster = args.includes('--no-cluster');
    const inputPath = args.replace('--no-cluster', '').trim();

    if (!inputPath) {
      await bot.sendMessage(chatId, '用法: `/wiki import <路径或文件>` [--no-cluster]\n\n示例:\n`/wiki import ~/Documents/notes`\n`/wiki import ~/report.pdf`');
      return;
    }

    const resolvedPath = inputPath.replace(/^~/, require('node:os').homedir());

    let stat;
    try { stat = require('node:fs').statSync(resolvedPath); }
    catch { await bot.sendMessage(chatId, `❌ 路径不存在: ${resolvedPath}`); return; }

    const isDir = stat.isDirectory();
    await bot.sendMessage(chatId, `⏳ 开始导入 ${isDir ? '目录' : '文件'}: \`${resolvedPath}\`\n${noCluster ? '（跳过聚类）' : '（含自动聚类）'}`);

    const { runWikiImport } = require('./wiki-import');
    const db = getDb();
    const logFn = (msg) => { log('INFO', msg); };

    try {
      const stats = await runWikiImport(db, resolvedPath, {
        providers, noCluster, log: logFn,
      });
      await bot.sendMessage(chatId,
        `✅ 导入完成\n\n` +
        `- 新建/更新页面: ${stats.imported}\n` +
        `- 跳过 (未变更): ${stats.skipped}\n` +
        `- 失败: ${stats.failed}\n` +
        `- 聚类页面: ${stats.clusters}\n\n` +
        `使用 \`/wiki\` 查看全部页面`
      );
    } catch (err) {
      log('ERROR', `[wiki-import] ${err.message}`);
      await bot.sendMessage(chatId, `❌ 导入失败: ${err.message}`);
    }
  }

  async function _handleHelp(bot, chatId) {
    await bot.sendMessage(chatId, [
      '📚 **Wiki 命令**',
      '',
      '`/wiki` — 列出所有知识页',
      '`/wiki research <关键词>` — 搜索知识',
      '`/wiki page <slug>` — 查看页面全文',
      '`/wiki sync` — 重建陈旧页面',
      '`/wiki import <路径>` — 导入本地文档 (md/txt/PDF)',
      '`/wiki pin <标签> [标题]` — 手工注册主题',
      '`/wiki open` — 在 Obsidian 中打开 vault',
    ].join('\n'));
  }

  return { handleWikiCommand };
}

module.exports = { createWikiCommandHandler };

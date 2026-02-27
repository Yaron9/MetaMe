#!/usr/bin/env node
/**
 * memory-write.js — Active memory injection CLI
 *
 * Usage:
 *   node memory-write.js "entity" "relation" "value"
 *   node memory-write.js "entity" "relation" "value" --confidence high --project metame --tags "tag1,tag2"
 *   node memory-write.js --help
 *
 * Reuses memory.js saveFacts() and acquire/release pattern. Zero new dependencies.
 */

'use strict';

const path = require('path');
const os   = require('os');

// ── Legal relation types ──────────────────────────────────────────────────────
const VALID_RELATIONS = new Set([
  'tech_decision',
  'bug_lesson',
  'arch_convention',
  'config_fact',
  'config_change',
  'user_pref',
  'workflow_rule',
  'project_milestone',
]);

// ── Entity whitelist (no dot required for these) ──────────────────────────────
const ENTITY_WHITELIST = new Set(['王总', 'system', 'user', 'MetaMe']);

// ── Help text ─────────────────────────────────────────────────────────────────
const HELP = `
memory-write.js — 主动写入事实到 memory.db

用法:
  node memory-write.js <entity> <relation> <value> [options]

参数:
  entity      知识主体，须含点号（如 MetaMe.daemon）或在白名单（王总/system/user/MetaMe）
  relation    关系类型，合法值：
                ${[...VALID_RELATIONS].join(', ')}
  value       事实内容，20-300 字符

选项:
  --confidence <level>   high | medium | low  （默认 medium）
  --project <key>        项目标识（默认从 cwd 推断，推断不到则 '*'）
  --tags <tag1,tag2>     最多 3 个标签，逗号分隔
  --help                 显示此帮助

示例:
  node memory-write.js "MetaMe.daemon" "bug_lesson" "修复X前必须先Y，否则Z会挂"
  node memory-write.js "MetaMe.bridge" "tech_decision" "飞书回调走 3000 端口，nginx 转发" --confidence high --project metame
`.trim();

// ── Project inference ─────────────────────────────────────────────────────────
function inferProject(cwd) {
  if (!cwd) return '*';
  const known = { 'MetaMe': 'metame', 'metame-desktop': 'desktop' };
  for (const [dir, key] of Object.entries(known)) {
    if (cwd.includes(dir)) return key;
  }
  return '*';
}

// ── Argv parser (zero deps) ───────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; i++; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
      if (val !== null) { opts[key] = val; i += 2; } else { opts[key] = true; i++; }
    } else {
      positional.push(a);
      i++;
    }
  }
  return { positional, opts };
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateEntity(entity) {
  if (!entity) return 'entity 不能为空';
  if (ENTITY_WHITELIST.has(entity)) return null;
  if (!entity.includes('.')) return `entity 格式不合法：须含点号（如 MetaMe.daemon）或为白名单值（${[...ENTITY_WHITELIST].join('/')}）`;
  return null;
}

function validateRelation(relation) {
  if (!relation) return 'relation 不能为空';
  if (!VALID_RELATIONS.has(relation)) {
    return `relation 不合法："${relation}"\n合法值: ${[...VALID_RELATIONS].join(', ')}`;
  }
  return null;
}

function validateValue(value) {
  if (!value) return 'value 不能为空';
  if (value.length < 20) return `value 太短（${value.length} 字符），最少 20 字符`;
  if (value.length > 300) return `value 太长（${value.length} 字符），最多 300 字符`;
  return null;
}

function validateConfidence(conf) {
  const valid = ['high', 'medium', 'low'];
  if (!valid.includes(conf)) return `confidence 不合法："${conf}"，合法值: high | medium | low`;
  return null;
}

// ── Resolve memory.js (supports both dev and deployed paths) ──────────────────
function resolveMemory() {
  const candidates = [
    path.join(os.homedir(), '.metame', 'memory.js'),
    path.join(__dirname, 'memory.js'),
  ];
  for (const p of candidates) {
    try { require.resolve(p); return p; } catch {}
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    process.exit(0);
  }

  const [entity, relation, value] = positional;
  const confidence = opts.confidence || 'medium';
  const project    = opts.project    || inferProject(process.cwd());
  const tagsRaw    = opts.tags       || '';
  const tags       = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean).slice(0, 3) : [];

  // Validate
  const errors = [
    validateEntity(entity),
    validateRelation(relation),
    validateValue(value),
    opts.confidence ? validateConfidence(confidence) : null,
  ].filter(Boolean);

  if (errors.length) {
    for (const e of errors) console.error('错误: ' + e);
    console.error('\n运行 node memory-write.js --help 查看用法');
    process.exit(1);
  }

  // Resolve memory module
  const memoryPath = resolveMemory();
  if (!memoryPath) {
    console.error('错误: 找不到 memory.js，请确认 MetaMe 已部署');
    process.exit(1);
  }

  const memory = require(memoryPath);
  const sessionId = 'manual-' + Date.now();

  if (typeof memory.acquire === 'function') memory.acquire();
  try {
    const result = memory.saveFacts(sessionId, project, [
      { entity, relation, value, confidence, tags },
    ]);

    if (result.saved > 0) {
      const preview = value.slice(0, 30) + (value.length > 30 ? '...' : '');
      console.log(`✓ 已保存 [${relation}] ${entity}: "${preview}"`);
      if (result.superseded > 0) {
        console.log(`  (已将 ${result.superseded} 条旧记录标记为 superseded)`);
      }
    } else {
      // skipped: duplicate or validation filtered by saveFacts
      console.log(`⚠ 未保存（可能是重复内容）。已跳过: ${result.skipped}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('错误: 写入失败 —', err.message);
    process.exit(1);
  } finally {
    try { if (typeof memory.release === 'function') memory.release(); } catch {}
  }
}

main();

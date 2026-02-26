/**
 * daemon-user-acl.js — MetaMe 多用户权限管理模块
 *
 * 角色体系：
 *   admin   — 全部权限（王总）
 *   member  — 可配置白名单操作
 *   stranger — 仅基础问答，无系统操作
 *
 * 配置文件：~/.metame/users.yaml（热更新，独立于 daemon.yaml）
 * 格式：
 *   users:
 *     ou_abc123: { role: admin, name: 王总 }
 *     ou_def456: { role: member, name: 老马, allowed_actions: [feedback, status, query] }
 *   default_role: stranger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const USERS_FILE = path.join(os.homedir(), '.metame', 'users.yaml');

// ─── YAML 轻量解析（无依赖） ─────────────────────────────────────────────────
// 只解析本文件需要的简单结构，不引入 js-yaml 依赖
function parseSimpleYaml(content) {
  const result = {};
  const lines = content.split('\n');
  let currentSection = null;
  let currentUserId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const stripped = trimmed.trim();

    if (indent === 0) {
      const m = stripped.match(/^(\w[\w_]*):\s*(.*)$/);
      if (m) {
        currentSection = m[1];
        if (m[2]) result[currentSection] = m[2];
        else result[currentSection] = {};
        currentUserId = null;
      }
    } else if (indent === 2 && currentSection === 'users') {
      const m = stripped.match(/^([\w_-]+):\s*\{?(.*)\}?$/);
      if (m) {
        currentUserId = m[1];
        result.users = result.users || {};
        result.users[currentUserId] = parseInlineObj(m[2]);
      }
    } else if (indent === 4 && currentSection === 'users' && currentUserId) {
      const m = stripped.match(/^([\w_]+):\s*(.+)$/);
      if (m) {
        result.users[currentUserId][m[1]] = parseYamlValue(m[2]);
      }
    } else if (indent === 2 && currentSection !== 'users') {
      const m = stripped.match(/^([\w_]+):\s*(.+)$/);
      if (m && typeof result[currentSection] === 'object') {
        result[currentSection][m[1]] = parseYamlValue(m[2]);
      }
    }
  }
  return result;
}

function parseInlineObj(str) {
  const obj = {};
  str = str.replace(/^\{|\}$/g, '').trim();
  if (!str) return obj;
  const parts = str.split(',').map(s => s.trim());
  for (const part of parts) {
    const m = part.match(/^([\w_]+):\s*(.+)$/);
    if (m) obj[m[1]] = parseYamlValue(m[2]);
  }
  return obj;
}

function parseYamlValue(val) {
  val = val.trim();
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  // Array like [a, b, c]
  if (val.startsWith('[') && val.endsWith(']')) {
    return val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  // Quoted string
  return val.replace(/^['"]|['"]$/g, '');
}

// ─── 序列化为 YAML ────────────────────────────────────────────────────────────
function serializeUsers(data) {
  const lines = [];
  if (data.default_role) lines.push(`default_role: ${data.default_role}`);
  lines.push('users:');
  for (const [uid, info] of Object.entries(data.users || {})) {
    const actions = info.allowed_actions
      ? `, allowed_actions: [${info.allowed_actions.join(', ')}]`
      : '';
    const name = info.name ? `, name: ${info.name}` : '';
    lines.push(`  ${uid}: { role: ${info.role}${name}${actions} }`);
  }
  return lines.join('\n') + '\n';
}

// ─── 加载用户配置 ─────────────────────────────────────────────────────────────
let _cachedUsers = null;
let _cachedMtime = 0;

function loadUsers() {
  try {
    const stat = fs.statSync(USERS_FILE);
    if (stat.mtimeMs !== _cachedMtime) {
      const content = fs.readFileSync(USERS_FILE, 'utf8');
      _cachedUsers = parseSimpleYaml(content);
      _cachedMtime = stat.mtimeMs;
    }
    return _cachedUsers || { users: {}, default_role: 'stranger' };
  } catch {
    return { users: {}, default_role: 'stranger' };
  }
}

function saveUsers(data) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, serializeUsers(data), 'utf8');
  _cachedMtime = 0; // 强制下次重新加载
}

// ─── 权限动作定义 ─────────────────────────────────────────────────────────────
// 每个 action 代表一类权限门控点
const ACTION_GROUPS = {
  // member 可开放的安全操作
  feedback:  { desc: '提交反馈' },
  status:    { desc: '查询系统状态 (/status, /tasks)' },
  query:     { desc: '自然语言问答（只读）' },
  file_read: { desc: '查看文件' },

  // admin 专属（不可赋予 member）
  system:    { desc: '系统操作 (/sh, /mac, /fix)' },
  agent:     { desc: 'Agent 调度与管理' },
  config:    { desc: '配置修改 (/reload, /model)' },
  admin_acl: { desc: '用户权限管理 (/user *)' },
};

const ROLE_DEFAULT_ACTIONS = {
  admin:   Object.keys(ACTION_GROUPS),       // 全部权限
  member:  ['query'],                         // 默认只能问答
  stranger: [],                               // 无系统权限，但允许基础问答由 askClaude readOnly 处理
};

// 不可赋予 member 的 admin 专属 action
const ADMIN_ONLY_ACTIONS = new Set(['system', 'agent', 'config', 'admin_acl']);

// ─── 核心 API ─────────────────────────────────────────────────────────────────

/**
 * 根据 senderId 解析用户上下文
 * @param {string|null} senderId  飞书 open_id
 * @param {object} config         daemon 配置（兼容旧 operator_ids）
 * @returns {object} userCtx { senderId, role, name, allowedActions, can(action) }
 */
function resolveUserCtx(senderId, config) {
  const userData = loadUsers();

  let role, name, allowedActions;

  if (!senderId) {
    // 无 ID（Telegram 等）— 兼容旧逻辑，视为 admin
    role = 'admin';
    name = 'unknown';
    allowedActions = ROLE_DEFAULT_ACTIONS.admin;
  } else {
    const userInfo = (userData.users || {})[senderId];

    if (userInfo) {
      role = userInfo.role || 'member';
      name = userInfo.name || senderId.slice(-6);
      if (role === 'admin') {
        allowedActions = ROLE_DEFAULT_ACTIONS.admin;
      } else if (role === 'member') {
        // member 的 allowed_actions = 默认 member 权限 ∪ 配置的扩展权限（过滤 admin-only）
        const extra = (userInfo.allowed_actions || []).filter(a => !ADMIN_ONLY_ACTIONS.has(a));
        allowedActions = [...new Set([...ROLE_DEFAULT_ACTIONS.member, ...extra])];
      } else {
        allowedActions = [];
      }
    } else {
      // 兼容旧 operator_ids：若 senderId 在 operator_ids 中，视为 admin
      const operatorIds = (config && config.feishu && config.feishu.operator_ids) || [];
      if (operatorIds.includes(senderId)) {
        role = 'admin';
        name = senderId.slice(-6);
        allowedActions = ROLE_DEFAULT_ACTIONS.admin;
      } else {
        role = userData.default_role || 'stranger';
        name = senderId.slice(-6);
        allowedActions = ROLE_DEFAULT_ACTIONS[role] || [];
      }
    }
  }

  return {
    senderId,
    role,
    name,
    allowedActions,
    isAdmin: role === 'admin',
    isMember: role === 'member',
    isStranger: role === 'stranger',
    can(action) { return allowedActions.includes(action); },
    readOnly: role !== 'admin',
  };
}

/**
 * 判断命令文本对应的 action 类型
 */
function classifyCommandAction(text) {
  if (!text) return 'query';
  const t = text.trim().toLowerCase();
  if (t.startsWith('/sh ') || t.startsWith('/mac ') || t.startsWith('/fix') || t.startsWith('/reset') || t.startsWith('/doctor')) return 'system';
  if (t.startsWith('/agent ') || t.startsWith('/dispatch')) return 'agent';
  if (t.startsWith('/model') || t.startsWith('/reload') || t.startsWith('/budget')) return 'config';
  if (t.startsWith('/user ')) return 'admin_acl';
  if (t.startsWith('/status') || t.startsWith('/tasks') || t.startsWith('/run ')) return 'status';
  if (t.startsWith('/')) return 'system'; // 未知 slash 命令默认需要 system 权限
  return 'query';
}

// ─── /user 管理命令处理 ───────────────────────────────────────────────────────

/**
 * 处理 /user 系列命令（仅 admin 可调用）
 * 返回 { handled: boolean, reply: string }
 */
function handleUserCommand(text, userCtx) {
  if (!text || !text.startsWith('/user')) return { handled: false };

  const args = text.trim().split(/\s+/);
  // args[0] = '/user', args[1] = subcommand

  const sub = args[1];

  if (!sub || sub === 'help') {
    return {
      handled: true,
      reply: `**用户权限管理**\n\n` +
        `/user list — 列出所有用户\n` +
        `/user add <open_id> <role> [name] — 添加用户 (role: admin/member)\n` +
        `/user role <open_id> <role> — 修改角色\n` +
        `/user grant <open_id> <action> — 赋予 member 额外权限\n` +
        `/user revoke <open_id> <action> — 撤销 member 权限\n` +
        `/user remove <open_id> — 移除用户\n` +
        `/user actions — 列出可用 action\n` +
        `/user whoami — 查看当前身份`,
    };
  }

  if (sub === 'whoami') {
    return {
      handled: true,
      reply: `**你的身份**\n\nID: \`${userCtx.senderId || 'N/A'}\`\n角色: ${userCtx.role}\n名称: ${userCtx.name}\n权限: ${userCtx.allowedActions.join(', ') || '无'}`,
    };
  }

  if (sub === 'actions') {
    const lines = Object.entries(ACTION_GROUPS).map(([k, v]) => `- \`${k}\` — ${v.desc}`);
    return { handled: true, reply: `**可用 Actions**\n\n${lines.join('\n')}` };
  }

  if (sub === 'list') {
    const data = loadUsers();
    const users = Object.entries(data.users || {});
    if (!users.length) return { handled: true, reply: '暂无用户配置（仅依赖 operator_ids）' };
    const lines = users.map(([uid, info]) => {
      const actions = info.allowed_actions ? ` | ${info.allowed_actions.join(',')}` : '';
      return `- \`${uid}\` [${info.role}] ${info.name || ''}${actions}`;
    });
    return { handled: true, reply: `**用户列表** (default: ${data.default_role || 'stranger'})\n\n${lines.join('\n')}` };
  }

  if (sub === 'add') {
    // /user add <open_id> <role> [name...]
    const [, , , uid, role, ...nameParts] = args;
    if (!uid || !role) return { handled: true, reply: '用法: /user add <open_id> <role> [name]' };
    if (!['admin', 'member', 'stranger'].includes(role)) {
      return { handled: true, reply: '角色必须是 admin / member / stranger' };
    }
    const data = loadUsers();
    data.users = data.users || {};
    data.users[uid] = { role, name: nameParts.join(' ') || uid.slice(-6) };
    saveUsers(data);
    return { handled: true, reply: `✅ 已添加用户 \`${uid}\` → ${role}` };
  }

  if (sub === 'role') {
    const [, , , uid, role] = args;
    if (!uid || !role) return { handled: true, reply: '用法: /user role <open_id> <role>' };
    if (!['admin', 'member', 'stranger'].includes(role)) {
      return { handled: true, reply: '角色必须是 admin / member / stranger' };
    }
    const data = loadUsers();
    data.users = data.users || {};
    if (!data.users[uid]) data.users[uid] = {};
    data.users[uid].role = role;
    saveUsers(data);
    return { handled: true, reply: `✅ 用户 \`${uid}\` 角色已更新为 ${role}` };
  }

  if (sub === 'grant') {
    const [, , , uid, action] = args;
    if (!uid || !action) return { handled: true, reply: '用法: /user grant <open_id> <action>' };
    if (ADMIN_ONLY_ACTIONS.has(action)) {
      return { handled: true, reply: `❌ \`${action}\` 是 admin 专属权限，不可赋予 member` };
    }
    if (!ACTION_GROUPS[action]) {
      return { handled: true, reply: `❌ 未知 action: ${action}，用 /user actions 查看可用列表` };
    }
    const data = loadUsers();
    data.users = data.users || {};
    if (!data.users[uid]) data.users[uid] = { role: 'member' };
    const existing = data.users[uid].allowed_actions || [];
    if (!existing.includes(action)) {
      data.users[uid].allowed_actions = [...existing, action];
      saveUsers(data);
    }
    return { handled: true, reply: `✅ 已授权 \`${uid}\` → ${action}` };
  }

  if (sub === 'revoke') {
    const [, , , uid, action] = args;
    if (!uid || !action) return { handled: true, reply: '用法: /user revoke <open_id> <action>' };
    const data = loadUsers();
    const userInfo = (data.users || {})[uid];
    if (!userInfo) return { handled: true, reply: `❌ 未找到用户 \`${uid}\`` };
    userInfo.allowed_actions = (userInfo.allowed_actions || []).filter(a => a !== action);
    saveUsers(data);
    return { handled: true, reply: `✅ 已撤销 \`${uid}\` 的 ${action} 权限` };
  }

  if (sub === 'remove') {
    const [, , , uid] = args;
    if (!uid) return { handled: true, reply: '用法: /user remove <open_id>' };
    const data = loadUsers();
    delete (data.users || {})[uid];
    saveUsers(data);
    return { handled: true, reply: `✅ 已移除用户 \`${uid}\`` };
  }

  return { handled: true, reply: `未知子命令: ${sub}，用 /user help 查看帮助` };
}

module.exports = {
  resolveUserCtx,
  classifyCommandAction,
  handleUserCommand,
  loadUsers,
  saveUsers,
  ACTION_GROUPS,
};

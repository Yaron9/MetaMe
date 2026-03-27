# MetaMe Intent 配置手册

> 自动部署到 `~/.metame/docs/hook-config.md`。源文件：`scripts/docs/hook-config.md`。只编辑 `scripts/`，不要直接改 `~/.metame/`。

---

## 架构概览

```
UserPromptSubmit (每轮用户输入)
  └── signal-capture.js      → 捕获用户偏好信号（写文件，不注入）

Daemon runtime (每轮真正发给引擎前)
  └── intent-registry.js     → 意图检测 + 按需拼接提示块

Stop (每轮结束)
  └── stop-session-capture.js → session 事件日志 + 工具失败捕获
```

`scripts/intent-registry.js` 是单一维护源，负责调用各意图模块并返回提示块。
daemon 在运行时直接复用同一 registry，Claude / Codex 共用这一条注入路径。
零匹配 → 零输出（不浪费 token）。

---

## 当前意图模块

| 模块 key | 文件 | 触发条件 | 注入内容 |
|---------|------|---------|---------|
| `agent_capability` | `intent-agent-capability.js` | 明确的 Agent 创建/绑定/激活/分身/团队/角色/Soul 管理语境 | 当前真实支持的 `/agent ...` `/activate` 能力提示 |
| `team_dispatch` | `intent-team-dispatch.js` | 检测到"告诉/让/发给 + 成员名"等联络意图 | `dispatch_to` 命令提示（仅匹配成员） |
| `ops_assist` | `intent-ops-assist.js` | 回退/日志/重启/gc/状态 相关语境 | `/undo` `/restart` `/logs` `/gc` `/status` 命令提示 |
| `file_transfer` | `intent-file-transfer.js` | "发给我/发过来/导出" 等文件传输语境 | `[[FILE:...]]` 协议 + 收发规则 |
| `weixin_bridge` | `intent-weixin-bridge.js` | "帮我绑定微信/配置微信桥接/开启微信接入/开始微信扫码登录" 等明确桥接语境 | 开启 `weixin.enabled` + `/weixin` 绑定流程提示 |
| `memory_recall` | `intent-memory-recall.js` | "上次/之前/还记得" 等跨会话回忆语境 | `memory-search.js` CLI 召回提示 |
| `doc_router` | `intent-doc-router.js` | "代码结构/脚本入口"、"hook/intent 配置" 等文档导向语境 | 统一 doc-router 文档指引 |
| `perpetual` | `intent-perpetual.js` | 永续/reactive 任务语境 | `dispatch_to` / `/status perpetual` 等永续协议提示 |
| `research` | `intent-research.js` | `paper_rev` 项目下的研究语境 | 研究方法与文件落点提示 |

注入策略：
- 零匹配 → 零输出
- 多模块命中时按优先级裁剪，默认最多注入 2 个 hint、总长不超过约 1200 字符
- `doc_router` 只作为 fallback；只要已有真实能力提示命中，就不再额外塞文档路由
---

## 开关控制

在 `~/.metame/daemon.yaml` 的 `hooks:` 段控制（不需要改代码）：

```yaml
hooks:
  agent_capability: true
  team_dispatch: true   # 改为 false 可禁用
  ops_assist: true
  weixin_bridge: true   # 默认开启；只匹配明确的微信配置/绑定语境
```

改完立即生效（daemon 每次发请求前都会读取）。
**不需要重启 daemon。**

---

## 新增意图模块（标准步骤）

1. **创建模块文件** `scripts/hooks/intent-<name>.js`：

```js
'use strict';
/**
 * @param {string} prompt     - 已清洗的用户输入
 * @param {object} config     - daemon.yaml 完整配置
 * @param {string} projectKey - 当前 METAME_PROJECT
 * @returns {string|null}     - 提示文本，或 null（不注入）
 */
module.exports = function detect<Name>(prompt, config, projectKey) {
  // 检测意图，返回 hint 字符串或 null
  if (!/你的关键词/.test(prompt)) return null;
  return '[提示标题]\n- 具体提示内容';
};
```

2. **注册到 intent-registry.js**：

```js
// scripts/intent-registry.js
const INTENT_MODULES = {
  agent_capability: require('./hooks/intent-agent-capability'),
  team_dispatch: require('./hooks/intent-team-dispatch'),
  ops_assist: require('./hooks/intent-ops-assist'),
  your_name: require('./hooks/intent-<name>'), // ← 加这行
};

const DEFAULTS = {
  // ...
  agent_capability: true,
  your_name: true,  // ← 加这行（默认开启）
};
```

文档路由类场景优先复用 `scripts/hooks/doc-router.js`，只传 `patterns + title + docPath + summary`，不要再为每个文档问题单独建样板模块。

3. **在 daemon.yaml 加开关**（可选，默认开）：

```yaml
hooks:
  your_name: true
```

4. **部署**：`node index.js`

5. **验证**：
```bash
node - <<'EOF'
const { buildIntentHintBlock } = require('./scripts/intent-registry');
console.log(buildIntentHintBlock('触发词', {}, ''));
EOF
```

---

## 调试

```bash
# 测试某个 prompt 是否触发意图
node - <<'EOF'
const { buildIntentHintBlock } = require('./scripts/intent-registry');
console.log(buildIntentHintBlock('告诉工匠去做这个', {
  projects: {
    business: {
      team: [{ key: 'builder', name: '工匠', nicknames: ['工匠'] }],
    },
  },
}, 'business'));
EOF

# 查看当前已注册的 hooks
python3 -c "
import json
s = json.load(open('/Users/$(whoami)/.claude/settings.json'))
for k, v in s.get('hooks', {}).items():
    print(k, [h['command'][-50:] for e in v for h in e.get('hooks',[])])
"

# 禁用某个意图（临时测试）：daemon.yaml 改 false，立即生效
```

---

## 文件路径参考

| 文件 | 说明 |
|------|------|
| `scripts/intent-registry.js` | 共享意图注册表（daemon 运行时唯一入口） |
| `scripts/hooks/intent-*.js` | 各意图模块（源文件） |
| `~/.metame/daemon.yaml` | 用户配置（包含 `hooks:` 开关） |
| `~/.claude/settings.json` | Claude Code hook 注册表 |

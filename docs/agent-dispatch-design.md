# Agent Dispatch 设计文档 — MetaMe 多 Agent 协作架构

> 状态：Draft | 作者：Jarvis | 日期：2026-02-20

## 1. 背景与动机

MetaMe 目前有多个独立 agent（3D/老马/贾维斯/因斯坦…），各自管理不同项目。
现状问题：
- Agent 之间**无法直接通信**，只能通过王总人肉中继
- 飞书 bot 的 `im.message.receive_v1` 事件**不推送 bot 自己发的消息**，所以 Feishu API 投递的消息 daemon 收不到
- 王总希望只对接一个总入口，内部任务自动流转

### 参考：Claude Code Agent Teams 的设计

Claude Code 官方的多 agent 协作采用**纯文件系统协议**：
- 每个 agent 有一个 `inbox.json`（收件箱）
- 发消息 = 写对方的 inbox 文件
- 并发安全靠 `tempfile + os.replace` 原子写入
- 零网络依赖，零消息队列

**我们采用同样的哲学：文件即通道。**

---

## 2. 架构总览

```
┌─────────────────────────────────────────────┐
│              王总 (飞书/Telegram)              │
│                    │                         │
│                    ▼                         │
│           metame_father (daemon.js)          │
│           ┌───────────────────┐              │
│           │  Dispatch Engine  │              │
│           │  - dispatchTask() │              │
│           │  - scanInbox()    │              │
│           │  - taskTracker    │              │
│           └───────┬───────────┘              │
│                   │                          │
│     ┌─────────────┼─────────────┐            │
│     ▼             ▼             ▼            │
│  inbox/        inbox/        inbox/          │
│  digital_me    desktop       metame          │
│  (3D)          (老马)        (贾维斯)         │
└─────────────────────────────────────────────┘

文件位置: ~/.metame/dispatch/
```

---

## 3. 核心设计

### 3.1 Inbox 文件结构

每个 project 有一个 inbox 文件：

```
~/.metame/dispatch/
  inbox-digital_me.jsonl     ← 3D 的收件箱
  inbox-desktop.jsonl        ← 老马的收件箱
  inbox-metame.jsonl         ← 贾维斯的收件箱
  dispatch-log.jsonl         ← 全局派发日志（审计用）
```

使用 JSONL（每行一条消息），追加写入，扫描后截断。

### 3.2 消息格式

```jsonc
{
  "id": "d_1708012345_abc",       // 唯一 ID
  "from": "digital_me",           // 发送方 project key
  "to": "desktop",                // 接收方 project key
  "type": "task",                 // task | message | callback
  "priority": "normal",           // urgent | normal | low
  "payload": {
    "title": "将 daemon 配置迁移到独立目录",
    "prompt": "请修改 config.ts ...",
    "context": "可选的上下文信息"
  },
  "callback": true,               // 完成后是否回调通知
  "created_at": "2026-02-20T14:12:00Z",
  "expires_at": "2026-02-21T14:12:00Z"  // 过期时间（可选）
}
```

### 3.3 写入协议（原子性保证）

```javascript
// 写入方（发送消息）
function dispatchTask(targetProject, message) {
  const inboxFile = path.join(DISPATCH_DIR, `inbox-${targetProject}.jsonl`);
  const line = JSON.stringify(message) + '\n';

  // 原子追加：写临时文件 → rename（Claude Code 同款方案）
  // JSONL 追加场景下，直接 appendFileSync 也安全（单进程写）
  fs.appendFileSync(inboxFile, line, 'utf8');

  // 记录到全局日志
  fs.appendFileSync(DISPATCH_LOG, JSON.stringify({
    ...message,
    dispatched_at: new Date().toISOString()
  }) + '\n');
}
```

### 3.4 读取协议（heartbeat 集成）

在现有 heartbeat 循环中加入 inbox 扫描：

```javascript
// 每个 heartbeat 周期（60s），检查当前 project 的 inbox
function scanInbox(projectKey, config) {
  const inboxFile = path.join(DISPATCH_DIR, `inbox-${projectKey}.jsonl`);
  if (!fs.existsSync(inboxFile)) return [];

  const content = fs.readFileSync(inboxFile, 'utf8').trim();
  if (!content) return [];

  // 读完即清空（原子替换为空文件）
  const tmpFile = inboxFile + '.tmp';
  fs.writeFileSync(tmpFile, '', 'utf8');
  fs.renameSync(tmpFile, inboxFile);

  // 解析所有待处理消息
  return content.split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(msg => !msg.expires_at || new Date(msg.expires_at) > new Date());
}
```

### 3.5 执行流程

```
heartbeat tick (60s)
  │
  ├─ 扫描 inbox-{project}.jsonl
  │   └─ 有新消息？
  │       ├─ type: "task" → askClaude(prompt) 执行任务
  │       ├─ type: "message" → 注入到当前 session 上下文
  │       └─ type: "callback" → 通知飞书群"任务已完成"
  │
  ├─ 执行完成后
  │   └─ callback: true？
  │       └─ 写 inbox-{from}.jsonl，type: "callback"
  │
  └─ 继续常规 heartbeat 任务
```

---

## 4. 防风暴机制

### 4.1 频率限制

```javascript
const DISPATCH_LIMITS = {
  max_per_hour_per_target: 5,     // 每小时每个目标最多 5 个任务
  max_total_per_hour: 20,         // 每小时总派发上限
  max_depth: 2,                   // 最大转发深度（A→B→C，不允许 C 再转发）
};
```

### 4.2 循环检测

每条消息携带 `chain` 字段记录流转路径：

```jsonc
{
  "chain": ["digital_me", "desktop"]  // 3D → 老马
}
```

发送前检查：如果 `chain` 中已包含目标 project，拒绝发送（防止 A→B→A 循环）。

### 4.3 过期清理

- 消息默认 24h 过期
- scanInbox 时自动丢弃过期消息
- dispatch-log.jsonl 每周轮转（保留 7 天）

---

## 5. 王总视角：全局任务追踪

### 5.1 /dispatch 命令（飞书/Telegram）

```
/dispatch status          → 查看所有进行中的跨 agent 任务
/dispatch log             → 最近 10 条派发记录
/dispatch to 老马 "xxx"   → 手动下发任务
```

### 5.2 /status 命令增强

现有 `/status` 追加 dispatch 信息：

```
📊 团队状态
─────────────
💅 个人助理  — 空闲
📊 3D       — 执行中: daily-write
🚀 老马     — 执行中: 配置迁移（来自: 贾维斯）
🤖 贾维斯   — 空闲
─────────────
📬 待处理任务: 0
📤 今日派发: 3
```

---

## 6. 实施计划

### Phase 1：文件 inbox + heartbeat 扫描（最小可用）

改动范围：**仅 `daemon.js`**

1. 新增 `~/.metame/dispatch/` 目录
2. `dispatchTask(target, message)` — 写 inbox 文件
3. `scanInbox(project)` — 在 heartbeat 循环中扫描
4. 扫描到任务后调用现有 `askClaude()` 执行
5. 完成后写 callback 到发送方 inbox
6. 新增 `/dispatch` 命令

### Phase 2：飞书 + 全局状态

1. `/dispatch status` 和 `/status` 增强
2. 飞书群内通知任务进度
3. dispatch-log 可视化

---

## 7. 与飞书的关系

**飞书仍然是人机接口，不是 agent-to-agent 接口。**

```
人 ←→ 飞书 ←→ daemon（人机通道）
agent ←→ inbox 文件 ←→ agent（机机通道）
```

飞书在 dispatch 中的角色：
- 王总通过 `/dispatch to 老马 "xxx"` 手动下发
- 任务完成后通知飞书群（单向，通知而非指令）
- 系统状态查询

---

## 8. 安全边界

| 操作 | 权限 |
|------|------|
| 读取其他 agent 的 inbox | 禁止（每个 agent 只读自己的） |
| 修改 daemon.yaml / daemon-desktop.yaml | 禁止（3D 事故教训） |
| 修改其他 project 的代码文件 | 需要通过 dispatch 下发，不能直接跨目录写 |
| dispatch 给自己 | 允许（自派任务场景） |
| 无限转发 | 禁止（max_depth: 2） |

---

## 9. 一句话总结

**文件即通道，heartbeat 即调度，daemon 即总线。**

零新依赖，零新端口，在现有 daemon.js 心跳循环里加 ~100 行代码即可实现 agent-to-agent 任务派发。

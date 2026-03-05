# MetaMe 维护手册（Claude/Codex 双引擎）

> 适用范围：`scripts/daemon.js` 后台 daemon 链路（飞书/Telegram 路由、会话执行、Agent 绑定）。

## 1. 引擎路由规则

### 手机端（daemon 生效）

- 路由入口：`chat_agent_map -> project -> project.engine`
- `project.engine` 可选值：`claude`（默认）/`codex`
- 未配置 `engine` 时等价 `claude`

示例：

```yaml
projects:
  reviewer:
    name: "Reviewer"
    cwd: "~/AGI/MetaMe"
    engine: codex

feishu:
  chat_agent_map:
    "oc_xxx": "reviewer"
```

### 电脑端（本期不新增 MetaMe CLI 子命令）

- 直接用原生命令：`claude` / `codex`
- `metame` CLI 不做 `metame codex` 子命令分流

## 2. Agent 创建与引擎写入

- 默认创建 Agent：不写 `engine` 字段（保持兼容）
- 创建语句中包含 `codex` 关键词：写入 `engine: codex`
- 绑定语句包含 `codex` 时同样支持写入 `engine: codex`

示例：

- `创建一个 codex agent，目录是 ~/projects/reviewer`
- `用 codex 建个代码审查 agent，目录 ~/projects/pr-review`

## 3. 会话与执行规则

- 引擎 runtime 工厂：`scripts/daemon-engine-runtime.js`
- 会话执行入口：`scripts/daemon-claude-engine.js`（Claude/Codex 共用）
- Session 回写：`patchSessionSerialized()` 串行化，避免 thread.started 竞态覆盖

### Codex 会话策略

- 首轮：`codex exec --json -`
- 续轮：`codex exec resume <thread_id> --json -`
- `resume` 失败自动重试：同一 `chatId` 在 10 分钟内最多 1 次
- 收到新 `thread_id` 时自动迁移 session id

## 4. 命令行为差异

- `/stop`：引擎中性，按 `activeProcesses.killSignal` 停止
- `/compact`：
  - Claude 会话：正常压缩
  - Codex 会话：返回“暂不支持，请继续同会话”

## 5. 运行时文件与状态

- 配置：`~/.metame/daemon.yaml`
- daemon 状态：`~/.metame/daemon_state.json`
- 活跃子进程：`~/.metame/active_agent_pids.json`

## 6. 常见故障排查

### Codex 认证失败

症状：返回 `AUTH_REQUIRED`

处理：

1. 执行 `codex login`
2. 或配置 `OPENAI_API_KEY`
3. 重新发送同一条消息

### Codex 频率限制

症状：返回 `RATE_LIMIT`

处理：

1. 等待限流窗口恢复
2. 降低并发或切回 Claude 路由

### 会话续接异常

症状：Codex `resume` 报错后反复失败

处理：

1. daemon 已自动做一次 fresh `exec` 重试
2. 若仍失败，手动 `/new` 新开会话
3. 检查 `~/.metame/active_agent_pids.json` 是否残留异常进程

## 7. 变更后维护动作

1. `npm test`
2. `npm run sync:plugin`
3. 更新文档：
   - `scripts/docs/pointer-map.md`
   - `README.md`
   - `README中文版.md`

# MetaMe v2.0: Multi-Agent Orchestrator (Swarm Intelligence)

## 1. 核心愿景 (Vision)
将 MetaMe 从一个单纯绑定 Claude Code 的“旁路辅助认知层 (Sidecar Profiler)”，升级为**“多智能体调度中枢 (Multi-Agent Orchestrator/Router)”**。
实现 Claude Code（主架构师）与 Codex 等轻量级 Agent（代码实现执行者）的异构协同，使其既能独立服务于用户，也能在统一的“认知大脑”下互相交互、流水线作业。

## 2. 核心价值 (Core Value)
1. **异构优势互补（Swarm Intelligence）**
   - **Claude Code (Sonnet 3.5)**: 擅长全局架构设计、深度推理、长上下文理解和复杂 Bug 排查。
   - **Codex (及其他轻量 Agent)**: 擅长快速单文件生成、补全，以及执行清晰明确的短小任务（速度快、成本低）。
2. **共享“认知底座”**
   - 所有的子智能体都共享 MetaMe 提取的 `memory.db`、`session_tags.json` 和 `claude_profile.yaml`。
   - 无论用户在调度哪个 Agent，Agent 都知道用户的代码红线、偏好习惯和项目架构约定。避免“换个工具就失忆”。
3. **“结对流水线”模式**
   - Claude 负责拆解需求输出规范文档（如 `CODE_PLAN.md`）。
   - MetaMe 监听任务状态，自动拉起 Codex 按步骤实现代码。
   - Codex 执行报错时，MetaMe 再将错误信息抛回给 Claude 进行 Review，形成闭环。

---

## 3. 架构解耦与重构点 (Architectural Shifts)

为了支持多个终端 CLI，必须在 MetaMe 内部抽象出“终端适配器（Provider/Agent Adapter）”：

### 3.1 信号捕获机制解耦 (Signal Hook Decoupling)
- **现状**：强依赖修改 `~/.claude/settings.json` 注入 `UserPromptSubmit` 钩子。
- **重构**：引入 Wrapper（代理包装器）模式。MetaMe 作为启动入口代理用户的 `stdin/stdout`，拦截输入进行偏好捕获后，再透传给后端实际的 CLI 进程（如 Codex）。

### 3.2 认知上下文注入解耦 (Context Injection Decoupling)
- **现状**：硬编码写入 `CLAUDE.md`，使用 `<!-- METAME:START -->` 标记。
- **重构**：抽象 `ContextInjector` 接口。如果是 Claude 则写入 `CLAUDE.md`；如果是 Codex 则生成专属的 `.codexrc`、环境变量或合并到系统提示词中。

### 3.3 会话日志解析解耦 (Session Parser Adapter)
- **现状**：`session-analytics.js` 和 `memory-extract.js` 强依赖于 Claude 专有的 `JSONL` 文件结构及其 `type: user/assistant` 的固定数据结构。
- **重构**：抽象**统一骨架协议（Unified Skeleton Protocol）**。
  - `ClaudeParser`：将 `.claude/projects/` 下的 JSONL 转换为标准 Skeleton。
  - `CodexParser`：将 Codex 的日志（SQLite / 纯文本等）转换为标准 Skeleton。
  - 后台提纯只认标准 Skeleton，不再关心日志源。

### 3.4 进程管理与锁机制 (Process & State Management)
- 子智能体交叉作业时容易引起文件冲突（如同时读写同一文件）。
- 需要实现基于文件系统的**轻量级工作区锁（Workspace Lock）**。
- 清理终端噪音（ANSI 控制符、进度条），确保 Agent 间交互的数据干净可解析。

---

## 4. 实施路径 (Implementation Phases)

### Phase 1: 适配层改造 (Decoupling & Dual Support)
- **目标**：不破坏现有 Claude Code 体验的前提下，让 MetaMe 能独立驱动 Codex。
- **任务**：
  1. 建立 `agents/claude-adapter.js` 和 `agents/codex-adapter.js`。
  2. 重构 `session-analytics.js`，加入 `Skeleton` 解析接口。
  3. 通过 MetaMe wrapper 命令启动 Codex（例如：`metame spawn codex`），验证 MetaMe profile 偏好能否成功注入 Codex 会话。

### Phase 2: 单向接力与流水线 (The Relay)
- **目标**：实现简单的文件级 Agent 协同。
- **任务**：
  1. 通过 Claude Code 生成特定的任务规划文件格式（如 `TASK_QUEUE.md`）。
  2. MetaMe 守护进程（Daemon）监听项目中该文件的变更。
  3. 当检测到 `TASK_QUEUE.md` 有未执行的任务，MetaMe 自动 `spawn` 拉起 Codex 并传入参数完成对应代码的编写修改。
  
### Phase 3: 显式接力与上下文继承 (Explicit Hand-off & Context Sharing)
- **目标**：拒绝“黑盒式”自动路由，把控制权绝对交还给用户。支持在一个终端流内进行显式跨 Agent 的接力和上下文继承，消除在多个独立终端间复制粘贴导致的上下文断裂（Context Loss）。
- **任务**：
  1. **显式调用协议（Explicit Invocation Protocol）**：支持在统一终端中指定目标 Agent，例如 `metame chat "@claude 实现登录逻辑，然后交给 @codex 审查"`。
  2. **会话上下文继承（Session Context Inheritance）**：当后续 Agent (如 Codex) 承接任务时，MetaMe 会自动将其前置（如 Claude）会话中关键的讨论、约束或红线一并注入，打破单纯的文件级隔离。
  3. **基于管道的信息反馈库（Information Pipeline）**：错误日志和 Review 意见能被无缝平移：例如 Codex 发现的不合规点可一键顺滑地抛回给 Claude 继续重构，从而形成高可控的结对编程体验。

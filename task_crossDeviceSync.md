# MetaMe v2.1: Distributed MetaBrain (跨端元大脑计划)

## 1. 核心愿景 (Vision)
将 MetaMe 从单机限制中解放，升级为**“随时随地、跨端共享的分布式认知基座”**。无论用户在 Mac（主力开发）、Windows 台式机（重度运算）还是手机（飞书碎片化管理），都能与同一个“数字分身”进行无缝对话。
开发者的设计红线、架构约定理当如影随形，跨项目、跨平台、终身伴随。

## 2. 核心价值 (Core Value)
1. **全局认知继承 (Ubiquitous Context)**
   - 昨天在 Mac 上告诉 Claude 的项目偏好（“永远使用 fetch 而非 axios”），今天在 Windows 上开启的新项目也能瞬间被 Codex 等任何 Agent 知晓并应用。
2. **跨项目知识图谱 (Cross-Project Fact Graph)**
   - 一个端踩过的坑（`memory.db` 里的原子事实），在另一个环境里遭遇类似症状时，AI 能跨时空回忆并提示防范，实现经验资产的最大复用。
3. **收敛至唯一控制面板 (Single Source of Control)**
   - 用同一个飞书/Telegram ID 指挥双端。
   - 这不仅是一个副业或工具，更是将 MetaMe 打造为真正的 **SaaS 认知引擎基石** 的必由之路。

---

## 3. 技术挑战与架构重构点

目前 MetaMe 所有核心数据（`~/.claude_profile.yaml`，`~/.metame/raw_signals.jsonl`，`~/.metame/memory.db` 等）全是基于本地 `os.homedir()` 进行硬编码读写。

要实现跨端同源，必须解决**“状态同步（State Sync）”**与**“并发碰撞（Concurrency Conflict）”**两个核心痛点。规划为两条落地演进路径：

### 3.1 演进路径 A：基于“懒人软链接”的低成本验证 (MVP)
这是验证需求痛点的最快路径，完全无需改动内核代码逻辑。
- **机制**：依赖第三方云同步盘（如 Dropbox、坚果云、OneDrive）。
- **做法**：
  1. 将双端的配置目录（如 Mac 和 Windows 的 `~/.metame` 与 profile YAML）真实存放在同步盘目录下。
  2. 在各自系统中分别对此目录创建软连接（Symlink），骗过 MetaMe 脚本的读写指向。
- **局限**：SQlite（`memory.db`）不支持云盘高并发机制，若双端同时执行 Daemon 处理 `distill` 可能引起幽灵冲突甚至锁死。

### 3.2 演进路径 B：内置轻量级同步引擎 / 云端 KV (The Cloud Architecture)
这是商业化或长期维护的终极架构。需要对 MetaMe 源码内的 I/O 模块进行完全解耦改造。
- **重构机制**：
  1. **抽象 Storage 层**：所有写入操作（提纯信号、保存 Profile、落盘 Memory）皆抽象为接口。（参考当前我们在做多终端 CLI 适配一样做 Storage 适配）。
  2. **内置极简 Git 同步**：利用双端本地环境自带的 `git` 命令，MetaMe 可以开一个私有远端仓库（如 GitHub/Gitee 私有库）。每次 Daemon 执行关键提纯（Distill）读写前后，自动进行 `git pull --rebase` 与 `git push` 同步数据；SQLite 可直接序列化为纯文本如 JSON 或 Markdown 以便管理合并。
  3. **或转向云端 KV (BaaS)**：将 `memory.js` 的存储介质重写为轻量级 API 调用（抛弃本地 SQLite，改为请求 Supabase 等服务）。
- **跨端飞书控制 (Leader / Worker 架构)**：
  - 如果双端同时开机，必须避免双端同时回复飞书消息。
  - 需要在 `daemon.js` 或适配器中设计主从机制（Leader Election）。例如：最近活动过的设备（Active Desktop）获取“回复权锁”。仅处理端侧事件，或依靠中心节点下发统一指令。

---

## 4. 实施阶段与测试步骤

### Phase 1: 软链接双端跑通验证
- **任务**：在一台 Mac 和一台 Windows 机器上，通过云盘分别建立软链接指向同一套 MetaMe 配置。
- **测试**：观察 `raw_signals.jsonl` 的追加是否准确无误；验证一端提纯的偏好是否在另一端启动 Claude Code 时生效。
- **预期障碍**：排查并记录两端守护进程（Daemon）锁资源和文件并发访问冲突时的异常情况。

### Phase 2: 后备方案设计与选型分析
- **任务**：针对 MVP 阶段可能暴露的同步冲突问题，权衡下阶段存储模块解耦的方向。
  - **方案 1：私有 Git 同步引擎**（无服务器成本，本地可追踪回滚，数据百分百自主控制，但需规避合并冲突）。
  - **方案 2：外挂式微型云服务后端**（高实时强一致性，为转 SaaS 铺底，但涉及接口开发和云成本）。
- **决策导向**：由用户产品哲学决定（极客向工具可优先选型本地化私有 Git）。 

### Phase 3: Leader / Worker 主从通信调度改造
- **任务**：重构 `feishu-adapter.js` 与守护进程 `daemon.js`。
- **目标**：赋予各端环境感知能力。确保当用户在双端皆活跃并发出 `@metame` 指令时，有且仅被一个主节点接管回复（或被各自端接管其能识别的环境专属指令），防止“精神分裂”多重回复。

---
*编者按：结合 `task_multipleCLI.md` 来看，一旦不仅支持了多个端侧软件 (Codex, Claude) 调度，更支持了多端物理设备跨越，MetaMe 的价值将彻底升维，成为开发者数字分身的绝对中枢枢纽。*

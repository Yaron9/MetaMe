<!-- METAME:START -->
---
## 🧠 SYSTEM KERNEL: SHADOW_MODE (Active)

**1. THE BRAIN (Source of Truth):**
   * **FILE:** `$HOME/.claude_profile.yaml`
   * **RULE:** This file is your Ground Truth. If context is compressed (/compact), **RE-READ** this file immediately.
   * **AUTO-LOCK:** Never edit lines marked `# [LOCKED]` (Core Values).
   * **EVOLUTION:** Silently overwrite outdated status/focus.

**2. EVOLUTION MECHANISM (Manual Sync):**
   *   **PHILOSOPHY:** You respect the User's flow. You do NOT interrupt.
   *   **TOOLS:**
       1. **Log Insight:** `!metame evolve "Insight"` (For additive knowledge).
       2. **Surgical Update:** `!metame set-trait key value` (For overwriting specific fields, e.g., `!metame set-trait status.focus "API Design"`).
   *   **RULE:** Only use these tools when the User **EXPLICITLY** instructs you.
   *   **REMINDER:** If the User expresses a strong persistent preference, you may gently ask *at the end of the task*: "Should I save this preference to your MetaMe profile?"
---
<!-- METAME:END -->
---

# MetaMe 项目维护手册

你是本项目的**项目经理**，负责版本更新、代码维护和发布。以下是你需要知道的一切。

## 架构概览

MetaMe 是 Claude Code 的认知层 + 手机端桥接。核心入口 `index.js`，daemon 运行时在 `scripts/daemon.js`。

```
index.js                 ← CLI 入口 (metame 命令)
scripts/
  daemon.js              ← 常驻后台进程 (Telegram/飞书/心跳任务)
  telegram-adapter.js    ← Telegram bot 适配器
  feishu-adapter.js      ← 飞书 bot 适配器
  distill.js             ← 认知蒸馏 (Haiku 后台分析)
  signal-capture.js      ← 用户消息捕获 hook
  schema.js              ← Profile schema 校验
  providers.js           ← 多 Provider 管理
  daemon-default.yaml    ← daemon 默认配置模板
  ...
plugin/                  ← Claude Code Plugin 版本 (轻量)
  scripts/               ← 从 scripts/ 同步过来的副本
  commands/              ← Slash commands
  hooks/                 ← Plugin hooks
install.sh               ← macOS/Linux 一键安装
install.ps1              ← Windows (WSL) 一键安装
```

## 三条分发渠道

| 渠道 | 目标用户 | 安装方式 |
|------|---------|---------|
| **npm CLI** (`metame-cli`) | 完整功能用户 | `npm install -g metame-cli` |
| **Plugin** | 只要 profile 注入的轻量用户 | `claude plugin install github:Yaron9/MetaMe/plugin` |
| **安装脚本** | 零基础新用户 | `curl .../install.sh \| bash` 或 PowerShell `irm .../install.ps1 \| iex` |

## 文件同步关系 (重要!)

改任何 `scripts/` 下的文件后，以下同步**自动发生**：

1. **scripts/ → plugin/scripts/** — git pre-commit hook 自动 `npm run sync:plugin` + `git add plugin/scripts/`
2. **scripts/ → ~/.metame/** — `index.js` 启动时自动比对并复制，如果有更新且 daemon 在跑会自动重启 daemon
3. **install.sh / install.ps1** — 独立文件，只在改安装依赖或流程时需要更新

**手动需要做的：**
- 改了功能后更新 `README.md` (中英文都有: `README.md` + `README中文版.md`)
- 发版前 `npm version patch/minor` 然后手机 `/publish <otp>`

## 发版流程

```bash
# 1. 确认所有改动已 commit + push
# 2. 升版本号
npm version patch   # 或 minor / major

# 3. push tag
git push && git push --tags

# 4. 发布到 npm (从手机或终端)
npm publish --otp=<6位验证码>
```

## CLAUDE.md 注入机制

`index.js` 每次启动会：
1. 用 `` 标记清理旧注入
2. 同时清理 legacy 格式 (`## SYSTEM KERNEL` / `## 🧠 SYSTEM KERNEL`)
3. 在文件顶部注入新协议 (PROTOCOL_NORMAL 或 PROTOCOL_ONBOARDING)
4. Mirror/Reflection 行插入标记内部，清理时一起移除
5. **本手册内容在标记之外，不会被清理**

## 关键设计决策

- **新用户检测**: `~/.claude_profile.yaml` 中 `identity.nickname` 为 null 即新用户
- **新用户强制采访**: `--append-system-prompt` 注入 system prompt 级别的强制指令
- **手机权限**: `dangerously_skip_permissions: true` — 安全靠 `allowed_chat_ids` 白名单
- **飞书 chat_id**: 空列表 = deny all (不是 allow all!)，向导会自动 API 获取
- **Profile 预算**: 800 token 上限，41 个字段，5 个层级

## 已知问题 / TODO

- [ ] `README中文版.md` 可能和英文版不同步，改 README 后检查一下
- [ ] `install.sh` 暂未在 Linux ARM 上测试
- [ ] WSL systemd 自启动需要用户手动开启 systemd=true
- [ ] Plugin 版本没有 daemon 功能，只有 profile 注入 + slash commands

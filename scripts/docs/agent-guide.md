# Agent 创建与管理指南

## 创建 Agent（完整流程）

用户说"创建agent"、"新建agent"、"帮我建个agent"时，按此流程引导：

### Step 1: 收集信息
需要两个必要信息：
- **工作目录**：Agent 的代码/项目目录（如 `~/projects/my-bot`）
- **角色描述**（可选）：Agent 的职责定义

如果用户没给目录，提示：
> 请告诉我 Agent 的工作目录，例如 `~/projects/my-bot`

### Step 2: 执行创建
在手机端（飞书/Telegram），直接说即可，daemon 会自动处理：
> 创建一个 Agent，目录是 ~/projects/my-bot

引擎选择（手机端自然语言）：
- 默认不写引擎时，使用 Claude（配置里不落 `engine` 字段）
- 句子里带 `codex` 关键词时，自动写入 `engine: codex`

示例：
> 创建一个 codex agent，目录是 ~/projects/reviewer

> 用 codex 建一个代码审查 agent，目录 ~/projects/pr-review

在桌面 Claude Code 终端，需要手动操作：
1. 创建项目目录和 CLAUDE.md（角色定义）
2. 编辑 `~/.metame/daemon.yaml`，在 `projects` 下新增：
   ```yaml
   projects:
     my_bot:
       name: "我的机器人"
       cwd: "~/projects/my-bot"
       icon: "🤖"
   ```
3. 运行 `touch ~/.metame/daemon.js` 触发热重载

### Step 3: 绑定群聊
告知用户：
> 请在飞书/Telegram 新建群组，把 bot 加进去，发送 `/activate` 完成绑定。

`/activate` 会自动将群与最近创建的 Agent 绑定（30分钟内有效）。

## 常用命令速查

| 操作 | 手机端命令 |
|------|-----------|
| 新建 Agent | `/agent new` 或自然语言"创建agent" |
| 绑定群 | `/activate` 或 `/agent bind <名称> [目录]` |
| 查看列表 | `/agent list` |
| 编辑角色 | `/agent edit` |
| 解绑群 | `/agent unbind` |
| 切换 Agent | 直接@昵称（仅非专属群） |

## 注意事项
- 专属群（chat_agent_map 中的群）永远绑定同一个 Agent，不能通过昵称切换
- 新群必须发 `/activate` 才能使用，未授权群会提示"此群未授权"
- 需要定位脚本入口、升级步骤或文件落点时，先看 `~/.metame/docs/pointer-map.md`

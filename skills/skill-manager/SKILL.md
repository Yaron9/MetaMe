---
name: skill-manager
description: 技能能力路由与治理。用于能力不足、工具缺失、任务失败，以及用户要求查找、安装、更新或管理 skill 时。
---

# Skill Manager — 技能系统总管

## 核心原则

你是技能系统的唯一决策入口。遇到任何能力问题，先来这里。不要自己瞎试，先看清全局再行动。复合任务先拆成独立子能力，每个子能力单独匹配 skill。

## 第一步：看清全局

```bash
python ~/.claude/skills/skill-manager/scripts/list_skills.py ~/.claude/skills 2>/dev/null
```

> `~/.claude/skills/` 是唯一的全局技能源；`~/.codex/skills` 与
> `~/.agents/skills` 只作为指向它的兼容入口。项目专属技能放在项目的
> `.claude/skills/`，并按需从 `.agents/skills/` 建立项目内软链接。

有匹配的 skill → **路径 A**。没有 → **路径 B**。

---

## 路径 A：调用现有 skill

读取对应 SKILL.md，按指引执行。完成后走路径 C。

## 路径 B：获取新能力

这是一条统一的流程，不管"知不知道怎么做"，都从调研开始。调研结果决定用哪个工具。

### B1. 调研（必做，不要跳过）

```
搜索："[任务关键词] skill" 或 "[任务] automation tool"
搜索："[平台名] API" 或 "如何自动化 [任务]"
```

目标：搞清楚有没有现成的东西能用，以及具体怎么做。

### B2. 根据调研结果选择路径

| 调研发现 | 行动 | 用哪个子系统 |
|---------|------|-------------|
| skills.sh 商城有现成 skill | 在本 skill 内评估并安装 | Skills CLI |
| GitHub 上有个项目能做这件事 | 研究后创建适配版本 | `skill-creator` |
| 找到了教程/方法，但没有现成工具 | 基于调研结果从零创建 | `skill-creator` |
| 什么都没找到 | 用自己的知识从零创建 | `skill-creator` |

**B2a. 商城安装（最便宜）**

```bash
npx skills find <关键词>
npx skills add <owner/repo@skill> -g -y
```

安装前必须检查：

- 与现有能力是否重复
- 来源、维护活跃度和许可证
- 是否引用未随安装提供的其他 skill、脚本或 MCP
- description 是否过宽，会不会常驻占用上下文或误触发

一次给出不超过 3 个候选，说明差异后再选择。安装完成后继续执行原任务。

**B2b. 从 GitHub 或方法创建**

调用 `skill-creator` skill，将调研到的流程写成 SKILL.md：
- 具体步骤（URL、按钮、等待元素）
- 前置依赖（Playwright MCP？登录？API Key？）
- 已知限制和坑
- 上游来源与许可证
- 本地适配点及验证方式

### B3. 验证

```bash
ls ~/.claude/skills/<技能名>/SKILL.md 2>/dev/null || ls ~/.agents/skills/<技能名>/SKILL.md 2>/dev/null
```

### B4. 用新 skill 执行原任务

不要停下来汇报安装情况，直接继续干活。完成后走路径 C。

## 路径 C：进化（任务完成后自动执行）

按 `skill-creator` 的 evolution 流程将本次经验写回 skill。只记有价值的踩坑、用户偏好和优化策略；没有新经验则跳过。

## 路径 D：更新过时 skill

```bash
python ~/.claude/skills/skill-manager/scripts/scan_and_check.py ~/.claude/skills
```

1. `python scripts/update_helper.py <skill_path>` 备份
2. 拉取新版本
3. 用 `skill-creator/scripts/smart_stitch.py <skill_path>` 恢复经验

## 子系统索引

| 子系统 | Skill 名 | 何时调用 |
|--------|----------|---------|
| 商城搜索与安装 | Skills CLI | B2a |
| 创建与适配 | `skill-creator` | B2b |
| 经验进化 | `skill-creator` | 路径 C |
| 环境修复 | `mcp-installer` | 工具缺失错误 |
| 深度调研 | `deep-research` | B1（复杂主题时） |
| 自愈诊断 | `self-diagnose` | Daemon 执行失败自动触发；手机 `/doctor` 手动触发 |

## Frontmatter 字段规范

扫描/升级 skill 时，确保 frontmatter 包含：
- `needs_browser: true` — 需要 Playwright 浏览器自动化的 skill 必须声明此字段，否则手机端会跳过 Playwright 加载（省 ~20s）

## 约束

- 单次最多安装 2 个新技能
- 优先可信且许可清晰的来源
- 已有能力能覆盖时不新增同类 skill
- 依赖 MCP 的技能先走 `mcp-installer` 自愈协议
- 商城：https://skills.sh/
- 删除：`python scripts/delete_skill.py <name> ~/.claude/skills`

---
name: skill-manager
description: 技能系统总管。AI 遇到任何能力不足、工具缺失、任务失败时，第一时间查阅此 skill。它掌握全部已安装技能的清单，决定是调用现有技能还是获取新技能，并在任务完成后自动进化技能库。触发条件：(1)任务执行失败或结果不理想，(2)需要的工具/能力不存在，(3)用户说"找技能"、"管理技能"、"更新技能"。本协议应自动触发，无需用户指令。
---

# Skill Manager — 技能系统总管

## 核心原则

你是技能系统的唯一决策入口。遇到任何能力问题，先来这里。不要自己瞎试，先看清全局再行动。复合任务先拆成独立子能力，每个子能力单独匹配 skill。

## 第一步：看清全局

```bash
python ~/.opencode/skills/skill-manager/scripts/list_skills.py ~/.claude/skills 2>/dev/null; python ~/.opencode/skills/skill-manager/scripts/list_skills.py ~/.opencode/skills 2>/dev/null
```

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
| skills.sh 商城有现成 skill | 直接装 | `find-skills` |
| GitHub 上有个项目能做这件事 | 包装成 skill | `github-to-skills` |
| 找到了教程/方法，但没有现成工具 | 基于调研结果从零创建 | `skill-creator` |
| 什么都没找到 | 用自己的知识从零创建 | `skill-creator` |

**B2a. 商城安装（最便宜）**
```bash
npx skills find <关键词>
npx skills add <owner/repo> -g -y
```

**B2b. GitHub 包装（中等成本）**

调用 `github-to-skills` skill，提供 GitHub URL，自动生成 skill。

**B2c. 从零创建（最贵）**

调用 `skill-creator` skill，将调研到的流程写成 SKILL.md：
- 具体步骤（URL、按钮、等待元素）
- 前置依赖（Playwright MCP？登录？API Key？）
- 已知限制和坑

### B3. 验证

```bash
ls ~/.claude/skills/<技能名>/SKILL.md 2>/dev/null || ls ~/.agents/skills/<技能名>/SKILL.md 2>/dev/null
```

### B4. 用新 skill 执行原任务

不要停下来汇报安装情况，直接继续干活。完成后走路径 C。

## 路径 C：进化（任务完成后自动执行）

查阅 `skill-evolution-manager`，将本次经验写回 skill。只记有价值的：踩过的坑、用户偏好、优化策略。没有新经验则跳过。

## 路径 D：更新过时 skill

```bash
python ~/.opencode/skills/skill-manager/scripts/scan_and_check.py ~/.claude/skills
```

1. `python scripts/update_helper.py <skill_path>` 备份
2. 拉取新版本
3. `python ~/.opencode/skills/skill-evolution-manager/scripts/smart_stitch.py <skill_path>` 恢复经验

## 子系统索引

| 子系统 | Skill 名 | 何时调用 |
|--------|----------|---------|
| 商城搜索 | `find-skills` | B2a |
| GitHub 包装 | `github-to-skills` | B2b |
| 从零创建 | `skill-creator` | B2c |
| 经验进化 | `skill-evolution-manager` | 路径 C |
| 环境修复 | `mcp-installer` | 工具缺失错误 |
| 深度调研 | `deep-research` | B1（复杂主题时） |
| 自愈诊断 | `self-diagnose` | Daemon 执行失败自动触发；手机 `/doctor` 手动触发 |

## Frontmatter 字段规范

扫描/升级 skill 时，确保 frontmatter 包含：
- `needs_browser: true` — 需要 Playwright 浏览器自动化的 skill 必须声明此字段，否则手机端会跳过 Playwright 加载（省 ~20s）

## 约束

- 单次最多安装 2 个新技能
- 优先可信来源（anthropics/、vercel-labs/）
- 依赖 MCP 的技能先走 `mcp-installer` 自愈协议
- 商城：https://skills.sh/
- 删除：`python scripts/delete_skill.py <name> ~/.claude/skills`

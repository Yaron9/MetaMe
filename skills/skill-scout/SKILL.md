---
name: skill-scout
description: |
  自主技能进化行为协议。当 AI 发现现有技能无法满足用户需求时，
  按优先级搜索、安装、验证新技能。
  触发词：找技能、技能不够、skill scout、find skill。
---

# Skill Scout — 自主技能发现与安装

当你发现当前技能库无法满足用户需求时，自动触发此协议。不需要用户指令。

## 触发条件

1. 用户请求的任务没有匹配的已安装 skill
2. 现有 skill 执行失败或结果不理想
3. 用户说"找技能"、"技能不够"、"有没有 skill 能做这个"

## 执行流程

### Step 1：快速扫描已有技能

```bash
ls ~/.claude/skills/*/SKILL.md 2>/dev/null | while read f; do
  dir=$(dirname "$f")
  name=$(basename "$dir")
  desc=$(head -10 "$f" | grep "description:" | head -1 | sed 's/description: *//')
  echo "$name: $desc"
done
```

有匹配 → 直接调用该 skill，流程结束。

### Step 2：搜索技能商城

```bash
npx skills find "<关键词>"
```

找到匹配 → 安装并执行：

```bash
npx skills add <owner/repo@skill> -g -y
```

### Step 3：搜索 GitHub

如果商城没有，用 WebSearch 搜索：

```
"<任务关键词> skill" OR "<任务> automation" site:github.com
```

找到合适的仓库 → 调用 `github-to-skills` skill 将其包装为本地 skill。

### Step 4：从零创建

如果以上都找不到现成方案，调用 `skill-creator` skill 基于调研结果创建新技能。

## 优先级顺序

1. **已安装 skill**（零成本）
2. **skills.sh 商城**（最快）
3. **GitHub 包装**（中等）
4. **从零创建**（最贵）

## 约束

- 单次最多安装 2 个新技能
- 优先可信来源（anthropics/、vercel-labs/、ComposioHQ/）
- 安装后立即验证 SKILL.md 可读
- 安装后继续执行用户原始任务，不要停下来汇报
- 依赖 MCP 的技能先走 `mcp-installer` 确保环境就绪

## 子系统依赖

| 需要时调用 | Skill 名 |
|-----------|----------|
| 商城搜索 | `find-skills` |
| GitHub 包装 | `github-to-skills` |
| 从零创建 | `skill-creator` |
| 环境修复 | `mcp-installer` |

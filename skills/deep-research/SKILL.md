---
name: deep-research
description: AI深度研究助手。对任何主题进行迭代式深度研究，结合搜索引擎、网页抓取和大语言模型生成详细研究报告。触发词：深度研究、调研、research。
version: 2.0.0
created_at: 2026-01-29
---

# Deep Research 深度研究

基于 [dzhng/deep-research](https://github.com/dzhng/deep-research) 思路，用 Claude Code 原生能力实现。

## 研究流程

收到研究请求后，按以下步骤执行：

### 1. 分解查询（广度）
根据主题生成 3-5 个不同角度的搜索查询：
- 基础概念/定义
- 最新进展/动态
- 技术实现/原理
- 应用场景/案例
- 对比/竞品

### 2. 迭代搜索（深度）
对每个查询：
1. `WebSearch` 获取搜索结果
2. `WebFetch` 抓取 2-3 个高质量页面详情
3. 提取关键信息，发现新问题
4. 对新问题继续搜索（迭代 1-2 轮）

### 2.5 NotebookLM 补充查询（可选）

如果用户的 NotebookLM 中有与主题相关的笔记本，可作为**私有知识源**补充公开搜索的盲区：

```bash
# 搜索是否有相关笔记本
python ~/.claude/skills/notebooklm-skill/scripts/run.py notebook_manager.py search --query "关键词"

# 查询笔记本获取有引用的回答
python ~/.claude/skills/notebooklm-skill/scripts/run.py ask_question.py --question "具体问题" --notebook-id ID
```

**使用时机**：
- 话题涉及用户个人积累的领域知识（已上传到 NotebookLM）
- 公开搜索结果不够深入，需要私有资料补充
- 用户主动要求"查一下我的 NotebookLM"

**不要**每次调研都自动查 NotebookLM，只在相关时使用。

### 3. 综合报告
整合所有信息，输出结构化报告：

```markdown
# [主题] 深度研究报告

## 摘要
[3-5 句核心发现]

## 背景与定义
## 技术原理/核心机制
## 最新进展
## 应用场景
## 竞品对比（如适用）
## 未来展望
## 参考来源
```

## 使用示例

用户说：
- "深度研究一下 AI Agent"
- "调研 MCP 协议的最新进展"
- "research Claude Code 的竞品"

## 输出位置

报告写入：`/tmp/research_report.md`

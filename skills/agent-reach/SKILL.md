---
name: agent-reach
description: 免费多平台信息采集CLI（Twitter/YouTube/B站/小红书/抖音/Reddit/LinkedIn/GitHub/RSS/网页）。触发：agent reach、爬取、读网页、搜推特、搜B站。**WebFetch 失败时优先用此 skill**：凡遇到 JS 渲染页面（Twitter/X、Instagram、LinkedIn 等）或 WebFetch 返回空内容/JavaScript错误，无需重试 WebFetch，直接调用此 skill。
---

# Agent Reach

免费开源的多平台信息采集 CLI，安装后直接调用上游工具。

## 首次使用 / 诊断

```bash
agent-reach doctor        # 查看各平台状态
agent-reach install --env=auto  # 自动安装依赖
```

## 详细命令参考

完整的平台命令和配置指南在上游 SKILL.md：
```bash
cat /tmp/Agent-Reach/agent_reach/skill/SKILL.md
```

如果 /tmp 已清理，重新获取：
```bash
pip show agent-reach | grep Location
# 然后读取 <location>/agent_reach/skill/SKILL.md
```

或直接查看：https://github.com/Panniantong/Agent-Reach/blob/main/agent_reach/skill/SKILL.md

## 快速速查

| 平台 | 工具 | 示例 |
|------|------|------|
| 任意网页 | Jina | `curl -s "https://r.jina.ai/URL"` |
| Twitter | xreach | `xreach search "query" --json -n 10` |
| YouTube | yt-dlp | `yt-dlp --dump-json "URL"` |
| B站 | yt-dlp | `yt-dlp --dump-json "bilibili URL"` |
| Reddit | curl | `curl -s "https://reddit.com/r/xxx/hot.json?limit=10"` |
| GitHub | gh | `gh search repos "query" --sort stars` |
| 小红书 | mcporter | `mcporter call 'xiaohongshu.search_feeds(...)'` |
| 抖音 | mcporter | `mcporter call 'douyin.parse_douyin_video_info(...)'` |
| LinkedIn | mcporter | `mcporter call 'linkedin.get_person_profile(...)'` |
| RSS | feedparser | Python `feedparser.parse(url)` |

## Cookie 配置（需登录的平台）

```bash
agent-reach configure --from-browser chrome    # 自动提取
agent-reach configure twitter-cookies "auth_token=xxx; ct0=yyy"  # 手动
```

> 提醒用户使用专用小号，Cookie 登录有封号风险。


<!-- METAME-EVOLUTION:START -->

## User-Learned Best Practices & Constraints

> **Auto-Generated Section**: Maintained by skill-evolution-manager. Do not edit manually.

### Known Fixes & Workarounds
- Repeatedly failing on Twitter/X links (signals #7, #15, #30 all tool_failure); improve X.com social media parsing robustness or add fallback extraction method for social platforms

<!-- METAME-EVOLUTION:END -->

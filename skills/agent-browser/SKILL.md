---
name: agent-browser
description: AI Agent 专属无头浏览器 CLI（省 token 80%）。触发：网页自动化、打开网页、点击填表、截图抓快照、agent-browser。
version: "1.0.0"
tool: agent-browser
install: npm install -g agent-browser && agent-browser install
---

# agent-browser — AI Agent 专属浏览器

## 核心优势

| 特性 | agent-browser | MCP playwright |
|------|--------------|----------------|
| 快照 token 消耗 | ~80% 更少 | 较多 |
| 安装方式 | 全局 CLI | MCP Server |
| 调用方式 | Bash 工具 | 专用 MCP 工具 |
| 底层引擎 | Playwright | Playwright |
| 状态持久化 | session 文件 | MCP 进程生命周期 |
| Electron 桌面 App | ✅ 支持 | ❌ 不支持 |

## 安装验证

```bash
agent-browser --version   # 应输出版本号（当前 0.15.2）
```

若未安装：
```bash
npm install -g agent-browser
agent-browser install      # 安装 Chromium
```

## 核心工作流

### 1. 打开页面 + 抓快照（核心循环）

```bash
agent-browser open <url>
agent-browser snapshot          # 输出带 @ref 的可交互元素树
```

快照格式示例：
```
- heading "Example Domain" [ref=e1] [level=1]
- link "Learn more" [ref=e2]
```

AI 直接用 `@e1`、`@e2` 引用元素，无需 CSS/XPath 选择器。

### 2. 常用操作命令

```bash
# 导航
agent-browser open <url>
agent-browser back / forward / reload

# 交互
agent-browser click @e3
agent-browser fill @e5 "搜索内容"
agent-browser press Enter
agent-browser hover @e7
agent-browser select @e4 "选项值"
agent-browser upload @e6 /path/to/file

# 信息获取
agent-browser get text @e2
agent-browser get title
agent-browser get url
agent-browser is visible @e1
agent-browser is enabled @e2

# 视觉工具
agent-browser screenshot /tmp/debug.png
agent-browser screenshot --annotate /tmp/annotated.png   # 带元素标注

# 等待
agent-browser wait @e1            # 等元素出现
agent-browser wait 2000           # 等 2 秒

# 执行 JS
agent-browser eval "document.title"
```

### 3. 语义查找（不用 @ref）

```bash
agent-browser find role button "提交"      # 按 ARIA role 找
agent-browser find text "登录"             # 按文本找
agent-browser find label "用户名"          # 按 label 找
agent-browser find placeholder "请输入"    # 按 placeholder 找
```

### 4. 状态管理

```bash
# 保存登录状态
agent-browser set session ~/.agent-sessions/github.json

# 后续会话复用
agent-browser open github.com --session ~/.agent-sessions/github.json
```

## 标准 Agent 任务模板

```bash
# Step 1: 打开目标页面
agent-browser open <url>

# Step 2: 抓快照，识别元素
agent-browser snapshot
# AI 分析快照，找到目标 @ref

# Step 3: 执行操作
agent-browser click @eN
agent-browser fill @eM "内容"
agent-browser press Enter

# Step 4: 等待并验证结果
agent-browser wait ".success-msg"
agent-browser get text ".result"

# Step 5: 截图留档（可选）
agent-browser screenshot /tmp/result.png
```

## 与 MCP Playwright 协作策略

**用 agent-browser 的场景：**
- token 预算紧张的长流程任务
- 需要控制 Electron 桌面 App（Discord、Figma、Notion 等）
- 简单的网页自动化脚本

**继续用 MCP playwright 的场景：**
- 已有 playwright MCP 连接且不想切换
- 需要精细的 Playwright API（network mock、tracing）
- 现有工作流已稳定

## 常见错误处理

| 错误 | 处理 |
|------|------|
| `command not found` | 运行 `npm install -g agent-browser` |
| 浏览器未安装 | 运行 `agent-browser install` |
| 元素点击失败 | 先 `snapshot` 确认 @ref，改用 `find` 语义查找 |
| 页面未加载完 | 在操作前加 `agent-browser wait 1500` 或等待特定元素 |

## 进阶：连接现有浏览器

```bash
# 连接 CDP 调试端口（可复用已登录的 Chrome）
agent-browser connect 9222
```

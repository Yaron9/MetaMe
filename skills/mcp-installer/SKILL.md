# MCP 安装与管理协议

当用户要求安装、启用或管理 MCP 工具时，执行本协议。

触发词：安装 MCP、装个 MCP、启用 XXX、mcp install、浏览器自动化、安装 playwright

## 核心原则

1. **先调研，再写配置** — 不凭感觉猜配置，先搜索官方文档
2. **写完配置即生效** — daemon 每次 spawn 新进程会自动加载最新配置，无需重启
3. **发现缺失就自己装** — 不要停下来问用户

## MCP 配置格式

配置文件：`~/.config/opencode/opencode.json`（全局）或项目目录下 `opencode.json`

```json
{
  "mcp": {
    "服务名称": {
      "type": "local",
      "command": ["npx", "-y", "@some/mcp-server@latest"],
      "environment": { "API_KEY": "xxx" },
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

### Local 类型（最常见）

```json
{
  "type": "local",
  "command": ["命令", "参数1", "参数2"],
  "environment": {},
  "enabled": true,
  "timeout": 5000
}
```

- `command`: 字符串数组，第一个元素是可执行文件，后面是参数
- `environment`: 可选，环境变量
- `enabled`: 可选，默认 true
- `timeout`: 可选，请求超时毫秒数，默认 5000

### Remote 类型

```json
{
  "type": "remote",
  "url": "https://api.example.com/mcp",
  "headers": { "Authorization": "Bearer xxx" },
  "enabled": true
}
```

## 安装流程

### 第 1 步：调研

用户说"帮我装个 XXX MCP"时：

1. 搜索该 MCP server 的 npm 包名或 GitHub 仓库
2. 查找官方文档中的启动命令和配置方式
3. 确认需要哪些环境变量（API Key 等）

常见 MCP server 速查：

| 名称 | 包名 | 命令 |
|------|------|------|
| Playwright（浏览器） | `@playwright/mcp` | `["npx", "-y", "@playwright/mcp@latest", "--browser", "chrome"]` |
| Filesystem（文件系统） | `@anthropic/mcp-filesystem` | `["npx", "-y", "@anthropic/mcp-filesystem@latest", "/path"]` |
| GitHub | `@anthropic/mcp-github` | `["npx", "-y", "@anthropic/mcp-github@latest"]`，需要 `GITHUB_TOKEN` |
| Slack | `@anthropic/mcp-slack` | `["npx", "-y", "@anthropic/mcp-slack@latest"]`，需要 `SLACK_TOKEN` |
| Memory（知识图谱） | `@anthropic/mcp-memory` | `["npx", "-y", "@anthropic/mcp-memory@latest"]` |

如果不在速查表中，**必须先搜索**：
```bash
npm search mcp-server-XXX 2>/dev/null || echo "未找到，尝试 GitHub 搜索"
```

### 第 2 步：安装依赖

```bash
# 检查基础依赖
which npx node 2>/dev/null || echo "需要安装 Node.js"
which brew 2>/dev/null || echo "需要安装 Homebrew"
```

如果缺 Node.js：
```bash
brew install node  # 如果有 brew
# 或
curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | /bin/bash
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install node
```

预热 MCP 包（下载到缓存）：
```bash
npx -y @some/mcp-server@latest --help 2>/dev/null || true
```

### 第 3 步：写入配置

读取现有配置，合并新 MCP 条目：

```bash
# 读取现有配置
cat ~/.config/opencode/opencode.json 2>/dev/null || echo '{}'
```

然后用文件写入工具把新的 MCP 条目合并进 `mcp` 字段。**不要覆盖已有配置**，只添加新条目。

### 第 4 步：确认

告知用户："XXX MCP 已配置完成，下一条消息就能使用新工具了。"

如果需要 API Key 等凭据，告知用户设置环境变量的方法。

## 环境自愈（自动触发）

当执行任务过程中遇到以下情况时，**自动执行修复**：

| 错误信息 | 自动修复 |
|---------|---------|
| `command not found: npx` | `brew install node` |
| `command not found: brew` | 安装 Homebrew |
| `ENOENT` + mcp server | `npx -y @包名@latest --help` 预热 |
| npm 缓存损坏 | `rm -rf ~/.npm/_npx` 后重试 |

## 注意事项

- Homebrew 安装需要 sudo 密码时才告知用户
- 不要在 daemon 环境下启用 Playwright MCP（启动慢 ~20s，已在代码中自动跳过）
- API Key 类环境变量建议写入 `~/.zshrc` 或 `~/.bashrc` 而非配置文件明文

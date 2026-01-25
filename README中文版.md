# 🔮 MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

> **Claude Code 的“元认知”层 (The Meta-Cognitive Layer)**
>
> *将你的 AI 助手变成一面心理镜像：它了解你，随你进化，并时刻守护你的核心原则。*

## 📖 简介 (Introduction)

**Claude Code** 是一个强大的工具，但它患有“项目失忆症”。每当你切换文件夹时，它就会忘记你是谁、你的沟通风格以及你的具体限制。

**MetaMe** 通过为 Claude 包裹一层 **“元认知层”** 来解决这个问题。它创建了一个跟随你穿梭于所有项目的  **“全局大脑”** 。它了解你的心理画像，监控你的压力状态，并尊重你的核心原则——无需你每次重复强调。

它不仅仅是一个启动器；它是你的  **元分身 (Meta Avatar)** 。

## ✨ 核心特性 (Key Features)

* **🧠 全局大脑 (`~/.claude_profile.yaml`)：** 关于你身份的“唯一真理来源”。存储你的昵称、压力状态和认知特征，跨项目共享。
* **🧬 进化机制 (Evolution Mechanism)：** 你掌握控制权。使用 `!metame evolve` 手动教导 Claude 你的新偏好或限制，确保它在每次交互中变得更聪明。
* **🤝 动态握手协议 (Dynamic Handshake)：** 即“金丝雀测试”。MetaMe 会强制 AI 在回复的第一句话中通过你的 **代号 (Codename)** 来称呼你。如果它没叫你的名字，你就知道元认知连接已断开。
* **🛡️ 自动锁定机制 (Auto-Lock)：** 在配置文件中为任何值添加 `# [LOCKED]`，MetaMe 就会将其视为不可动摇的“宪法”，防止 AI 随意修改。
* **🔌 智能注入 (Smart Injection)：** 自动将你的个人档案注入到你进入的任何项目的 `CLAUDE.md` 中，实现无缝的上下文切换。

## 🛠 前置要求 (Prerequisites)

MetaMe 是 **Claude Code** 的外壳。你必须先安装 Node.js 和官方的 Claude Code 工具。

1. **Node.js** : 版本 14 或更高。
2. **Claude Code** :
   **Bash**

```
   npm install -g @anthropic-ai/claude-code
```

1. **认证** : 确保你已经运行过 `claude login` 并登录成功。

## 📦 安装 (Installation)

通过 NPM 全局安装 MetaMe：

**Bash**

```
npm install -g metame-cli
```

*(注意：如果你在 Mac/Linux 上遇到权限错误，请使用 `sudo npm install -g metame-cli`)*

## 🚀 使用指南 (Usage)

忘掉 `claude` 命令吧。从现在起，只需输入：

**Bash**

```
metame
```

或者，如果你喜欢混合大小写（效果一样）：

**Bash**

```
MetaMe
```

### 初次运行：创世纪 (The First Run)

当你第一次运行 MetaMe 时，它会检测到你的档案为空。它会暂停 AI 并进入 **校准模式 (Calibration Mode)** ：

1. 它会询问你的 **代号 (Codename/Nickname)**。
2. 它会开启一场 **深度认知访谈**，探索你的天赋领域、思维模式和潜在焦虑。
3. **请务必诚实**：它是一面镜子。你越坦诚（即便是关于你的恐惧），它就越能成为你的完美分身。
4. 完成后，它会保存你的“源代码”并启动 Claude。

### 日常工作流

1. `cd` 进入任何项目文件夹。
2. 运行 `metame`。
3. Claude 启动并立即说：*“Ready, [你的名字]...”*
4. 开始写代码。MetaMe 会在后台自动管理上下文。

### 热重载 (Hot Reload)

如果你更新了个人档案，或者需要修复断开的上下文连接，而**不想重启会话**：

*   **在 Claude 内部**：运行 `!metame refresh`
*   **在外部终端**：运行 `metame refresh`

这会立即将你最新的档案重新注入 `CLAUDE.md`。

## ⚙️ 配置与“全局大脑”

你的个人档案存储在你用户主目录下的一个隐藏 YAML 文件中。

**位置：** `~/.claude_profile.yaml`

你可以手动编辑此文件来更新你的状态或锁定你的价值观。

**档案示例：**

**YAML**

```
identity:
  role: Senior Architect
  nickname: Neo
status:
  focus: Refactoring Legacy Code
  pressure: High
cognition:
  crisis_reflex: Strategic_Analysis
  blind_spot: Perfectionism # [LOCKED]
values:
  core: "User Experience First" # [LOCKED]
```

* **`# [LOCKED]`** ：添加此注释可确保即使 AI 随着时间推移进化你的档案，这些特定的行也 **永远不会** 被覆盖。

## 🗑️ 卸载 (Uninstallation)

如果你希望从系统中彻底移除 MetaMe，请按照以下步骤操作：

### 1. 移除软件包

卸载 CLI 工具：

**Bash**

```
npm uninstall -g metame-cli
```

### 2. 移除全局大脑（可选）

如果你想删除存储的个人档案数据：

**Bash**

```
rm ~/.claude_profile.yaml
```

### 3. 清理项目文件（可选）

MetaMe 会在项目的 `CLAUDE.md` 文件头部添加一段协议。如果你想恢复原状，可以用文本编辑器删除以 `## 🧠 SYSTEM KERNEL` 开头的块。

## ⚡ 性能与成本 (Performance & Cost)

你可能会担心：*“这会吃掉我的上下文窗口吗？”*

**简短回答：不会。它甚至通过减少废话为你省钱。**

*   **上下文占用**：整个 MetaMe 内核 + 你的完整档案仅占用 **约 800 - 1000 tokens**。
*   **占比**：在 Claude 的 200k 上下文窗口中，这仅占 **0.5%**。
*   **投资回报**：通过预加载你的完整背景，它避免了每个新会话开头的“磨合期”和重复指令修正，而那些通常会浪费数千 tokens。

## ❓ 常见问题 (FAQ)

**Q: 这会覆盖我原本的 `CLAUDE.md` 吗？**
A: 不会。它只是将元认知协议 *插入* 到你现有 `CLAUDE.md` 的最顶部。你原本的项目笔记会保持原样。

**Q: 如果 Claude 突然不再叫我的昵称了怎么办？**
A: 这就是“金丝雀测试”失败了。这意味着上下文窗口被压缩了，或者文件链接断开了。在 Claude 中运行 `/compact` 或重启 `metame` 即可修复。

**Q: 我的数据会被发送给第三方吗？**
A: 不会。你的档案只保存在本地的 `~/.claude_profile.yaml` 中。MetaMe 只是将文本传递给官方的 Claude Code 工具。

## 📄 许可证 (License)

MIT License. 欢迎 Fork、修改并进化你自己的元认知系统。

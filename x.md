Claude Code 的 /insights 火了——"它烤了我的编码习惯"。

但 /insights 是一次性体检报告。

MetaMe 做的是持续追踪——每次 session 自动分析，跨 session 检测模式，偏离目标时主动提醒。

而且，它把 Claude Code 带到了你的手机上。

🧵

---

/insights vs MetaMe 的根本区别：

/insights: 手动跑 → HTML 报告 → 看完结束
MetaMe: 自动记录 → 持久存储 → 条件注入 → 主动提醒

一个是后视镜，一个是副驾驶。

更关键的是：MetaMe 不只分析你的行为，它记住你怎么想，而且可以在任何设备上工作。

---

MetaMe 的三层架构：

第一层：跨项目认知画像
→ 全局 Brain 文件（~/.claude_profile.yaml）
→ 记录你的思维方式、决策风格、沟通偏好
→ 不是记住事实，是记住"你怎么想"
→ 只占上下文 0.5%（600 tokens）

第二层：手机端完整 Claude Code
→ Telegram/飞书原生支持
→ 完整工具权限（Read/Edit/Bash/Task）
→ 有状态 session，同一对话历史
→ 文件传输（电脑↔手机双向）
→ /stop (ESC)、/undo (ESC×2) 完整终端控制

第三层：元认知追踪
→ 后知后觉：session 结束后记录 zone、认知负荷、目标对齐
→ 当知当觉：session 中被动注入观察（连续 2 次偏离）
→ 先知先觉：session 启动时直接提问引导（连续 2+ 次偏离，预防性干预）

---

真实场景 1：目标对齐

你声明 focus="冲刺国自然基金"
→ 连续 3 session 都在折腾副项目
→ MetaMe 标记 goal_alignment: drifted
→ 下次启动，Claude 被动持有观察
→ 聊到相关话题时温和回应

不说教，只照镜子。

真实场景 2：手机接力

电脑上写了一半代码
→ 出门坐地铁
→ 手机打开 Telegram
→ /last 恢复刚才的 session
→ 继续对话，完整工具权限
→ 回家后 metame continue 同步

桌面和移动无缝切换。

---

数据架构对比：

/insights:
→ LLM 分析 transcript → 生成 facets → 聚合统计
→ 优势：定性分析丰富，能捕捉复杂模式
→ 权衡：统计数字由 LLM 生成

MetaMe:
→ 结构化提取：项目/分支/工具/时长（本地解析）
→ 语义标注：Haiku 枚举分类（zone/负荷/对齐）
→ 观察区验证：3 次确认才写入 profile

设计理念：不让 LLM 生成统计数字，只让它做分类判断。

---

手机端完整 Claude Code 意味着什么？

不是"聊天机器人"，是真正的 Claude Code：

✅ 编辑文件（Read/Edit/Write）
✅ 运行命令（Bash）
✅ 搜索代码（Grep/Glob）
✅ 调用 Task agent
✅ 文件传输（双向）
✅ /stop 中断任务
✅ /undo 回退 + 文件恢复

所有这些，在 Telegram 或飞书里就能完成。

---

守护进程 + 自动化：

定时任务（cron 调度）+ 推送通知
多步骤 skill 链（deep-research → tech-writing → wechat-publisher）
代码变更自动热重启
macOS launchd 集成（开机自启 + 睡眠唤醒恢复）

让 Claude 在后台帮你工作，结果推送到手机。

---

快速开始：

npm install -g metame-cli

或作为 Claude Code 插件：
claude plugin install github:Yaron9/MetaMe/plugin

手机端：
metame daemon init  # 设置 Telegram/飞书
metame daemon start

GitHub: github.com/Yaron9/MetaMe

/insights 让你看到过去。
MetaMe 让你看到自己，并且随时随地陪着你。

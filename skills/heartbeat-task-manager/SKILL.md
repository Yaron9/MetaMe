---
name: heartbeat-task-manager
description: |
  管理 MetaMe Desktop 的心跳任务（提醒任务）。
  当用户说“每天提醒我…”、“6点提醒我…”时，优先用本技能自动创建/更新任务，
  并通过 /tasks、/run <task> 与手机端协同。
---

# Heartbeat Task Manager

用于 MetaMe Desktop Daemon 的心跳任务管理。

## 适用场景

- 用户说“每天提醒我…”
- 用户说“6点提醒我…”
- 用户要查看已有任务
- 用户要让后台立即执行某个任务

## 强约束

1. 仅操作 `~/.metame-desktop/config-desktop.yaml` 对应的 Desktop 任务域。
2. 不操作外部项目 daemon，不执行全局进程控制。
3. 优先使用 CLI 子命令，不手改 YAML 文本。

## 推荐流程

### 1) 新增/更新提醒任务

当用户给出提醒语句时，执行：

```bash
metame daemon --sub add-task --text "<用户原话>"
```

示例：

```bash
metame daemon --sub add-task --text "每天6点提醒我喝水"
metame daemon --sub add-task --text "每天提醒我复盘今天进展"
```

### 2) 查看任务列表

```bash
metame daemon --sub tasks
```

### 3) 手机端联动提示

创建成功后，告诉用户：

- 手机可发送 `/tasks` 查看列表
- 手机可发送 `/run <task>` 立即执行

## 回复模板（简短）

- 成功：
  - 已帮你设置提醒任务。
  - 你可以在手机输入 `/tasks` 查看，或 `/run <task>` 立即执行。
- 失败（语义不匹配）：
  - 我没识别到提醒语义，请改成“每天提醒我…”或“每天6点提醒我…”。


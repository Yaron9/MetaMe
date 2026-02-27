---
name: macos-mail-calendar
description: |
  macOS 系统邮箱与日历访问。通过 AppleScript 直接读写 Mail.app 和 Calendar.app，
  支持用户系统中所有已配置的邮箱账户（QQ、163、Gmail、Outlook、iCloud 等）和所有日历。
  零配置，无需 IMAP 密码或第三方依赖。
  触发词：邮件、邮箱、收件箱、日历、日程、会议、schedule、email、mail、calendar。
---

# macOS 邮箱与日历

通过 Bash 工具执行 `osascript` 访问 macOS 系统 Mail.app 和 Calendar.app。
用户系统中添加的所有邮箱和日历账户自动可用，无需额外配置。

## 重要原则

1. **只读优先** — 读取、搜索操作直接执行；发送邮件、创建/删除事件必须先向用户确认
2. **隐私** — 不要一次性读取大量邮件正文，先列出摘要让用户选择
3. **性能** — 搜索时限定范围（账户、日期、数量），避免遍历全部邮件
4. **编码** — AppleScript 输出是 UTF-8，中文邮件正常显示
5. **错误处理** — Mail.app 或 Calendar.app 未打开时 osascript 会自动启动它们（后台）

---

## 邮箱操作

### 列出所有邮箱账户

```bash
osascript -e 'tell application "Mail" to get name of every account'
```

### 读取最近 N 封收件箱邮件（摘要）

```bash
osascript -e '
tell application "Mail"
  set msgs to messages 1 thru 10 of inbox
  set output to ""
  repeat with m in msgs
    set output to output & "FROM: " & (sender of m) & linefeed & "SUBJECT: " & (subject of m) & linefeed & "DATE: " & (date received of m as string) & linefeed & "READ: " & (read status of m) & linefeed & "---" & linefeed
  end repeat
  return output
end tell
'
```

调整 `1 thru 10` 中的数字控制数量。

### 读取特定账户的收件箱

```bash
osascript -e '
tell application "Mail"
  set acct to account "ACCOUNT_NAME"
  set mb to mailbox "INBOX" of acct
  set msgs to messages 1 thru 5 of mb
  set output to ""
  repeat with m in msgs
    set output to output & "FROM: " & (sender of m) & linefeed & "SUBJECT: " & (subject of m) & linefeed & "DATE: " & (date received of m as string) & linefeed & "---" & linefeed
  end repeat
  return output
end tell
'
```

### 搜索邮件（按主题关键词）

```bash
osascript -e '
tell application "Mail"
  set foundMsgs to (messages of inbox whose subject contains "关键词")
  set cnt to count of foundMsgs
  if cnt = 0 then return "未找到匹配邮件"
  if cnt > 20 then set cnt to 20
  set output to "找到 " & (count of foundMsgs) & " 封，显示前 " & cnt & " 封：" & linefeed
  repeat with i from 1 to cnt
    set m to item i of foundMsgs
    set output to output & i & ". " & (sender of m) & " | " & (subject of m) & " | " & (date received of m as string) & linefeed
  end repeat
  return output
end tell
'
```

### 搜索邮件（按发件人）

```bash
osascript -e '
tell application "Mail"
  set foundMsgs to (messages of inbox whose sender contains "someone@example.com")
  -- 后续同上
end tell
'
```

### 读取邮件正文

```bash
osascript -e '
tell application "Mail"
  set m to message INDEX of inbox
  set c to content of m
  if length of c > 2000 then
    return text 1 thru 2000 of c
  else
    return c
  end if
end tell
'
```

将 `INDEX` 替换为邮件序号（1 = 最新）。正文截断到 2000 字符避免输出过长。

### 读取邮件附件信息

```bash
osascript -e '
tell application "Mail"
  set m to message INDEX of inbox
  set atts to mail attachments of m
  if (count of atts) = 0 then return "无附件"
  set output to ""
  repeat with a in atts
    set output to output & "NAME: " & (name of a) & " | SIZE: " & (MIME type of a) & linefeed
  end repeat
  return output
end tell
'
```

### 标记邮件已读/未读

```bash
# 标记已读
osascript -e 'tell application "Mail" to set read status of message INDEX of inbox to true'

# 标记未读
osascript -e 'tell application "Mail" to set read status of message INDEX of inbox to false'
```

### 发送邮件（需用户确认！）

```bash
osascript -e '
tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"主题", content:"正文内容", visible:true}
  tell newMsg
    make new to recipient at end of to recipients with properties {address:"收件人@example.com"}
  end tell
  send newMsg
end tell
'
```

**重要**：发送前必须将完整的收件人、主题、正文展示给用户确认。

### 创建草稿（不发送）

```bash
osascript -e '
tell application "Mail"
  set newMsg to make new outgoing message with properties {subject:"主题", content:"正文内容", visible:true}
  tell newMsg
    make new to recipient at end of to recipients with properties {address:"收件人@example.com"}
  end tell
  -- 不调用 send，邮件留在草稿箱
end tell
'
```

### 统计未读邮件

```bash
osascript -e '
tell application "Mail"
  set unreadCount to unread count of inbox
  return "未读邮件: " & unreadCount
end tell
'
```

---

## 日历操作

### 列出所有日历

```bash
osascript -e 'tell application "Calendar" to get name of every calendar'
```

### 查看今天的日程

```bash
osascript -e '
tell application "Calendar"
  set today to current date
  set time of today to 0
  set tomorrow to today + 1 * days
  set output to ""
  repeat with cal in calendars
    set evts to (every event of cal whose start date ≥ today and start date < tomorrow)
    repeat with e in evts
      set output to output & "📅 " & (name of cal) & " | " & (summary of e) & " | " & (start date of e as string)
      try
        set output to output & " ~ " & (end date of e as string)
      end try
      try
        set loc to location of e
        if loc is not "" and loc is not missing value then
          set output to output & " | 📍" & loc
        end if
      end try
      set output to output & linefeed
    end repeat
  end repeat
  if output = "" then return "今天没有日程安排 ✨"
  return output
end tell
'
```

### 查看指定日期的日程

```bash
osascript -e '
tell application "Calendar"
  set targetDate to date "2026-02-15"
  set time of targetDate to 0
  set nextDay to targetDate + 1 * days
  set output to ""
  repeat with cal in calendars
    set evts to (every event of cal whose start date ≥ targetDate and start date < nextDay)
    repeat with e in evts
      set output to output & (name of cal) & " | " & (summary of e) & " | " & (start date of e as string) & linefeed
    end repeat
  end repeat
  if output = "" then return "该日无日程"
  return output
end tell
'
```

### 查看本周日程

```bash
osascript -e '
tell application "Calendar"
  set today to current date
  set time of today to 0
  set weekEnd to today + 7 * days
  set output to ""
  repeat with cal in calendars
    set evts to (every event of cal whose start date ≥ today and start date < weekEnd)
    repeat with e in evts
      set output to output & (start date of e as string) & " | " & (name of cal) & " | " & (summary of e) & linefeed
    end repeat
  end repeat
  if output = "" then return "本周无日程"
  return output
end tell
'
```

### 创建日历事件（需用户确认！）

```bash
osascript -e '
tell application "Calendar"
  tell calendar "日历名称"
    set startDate to date "2026-02-15 14:00:00"
    set endDate to date "2026-02-15 15:00:00"
    make new event with properties {summary:"会议主题", start date:startDate, end date:endDate, location:"会议室 A"}
  end tell
end tell
'
```

**重要**：创建前必须向用户确认日历名称、时间、主题。

### 创建带提醒的事件

```bash
osascript -e '
tell application "Calendar"
  tell calendar "日历名称"
    set startDate to date "2026-02-15 14:00:00"
    set endDate to date "2026-02-15 15:00:00"
    set newEvent to make new event with properties {summary:"会议", start date:startDate, end date:endDate}
    -- 提前15分钟提醒
    tell newEvent
      make new display alarm at end of display alarms with properties {trigger interval:-15}
    end tell
  end tell
end tell
'
```

### 创建全天事件

```bash
osascript -e '
tell application "Calendar"
  tell calendar "日历名称"
    set eventDate to date "2026-02-15"
    make new event with properties {summary:"休假", start date:eventDate, allday event:true}
  end tell
end tell
'
```

### 搜索日历事件

```bash
osascript -e '
tell application "Calendar"
  set output to ""
  repeat with cal in calendars
    set evts to (every event of cal whose summary contains "关键词")
    repeat with e in evts
      set output to output & (name of cal) & " | " & (summary of e) & " | " & (start date of e as string) & linefeed
    end repeat
  end repeat
  if output = "" then return "未找到匹配事件"
  return output
end tell
'
```

### 删除事件（需用户确认！）

```bash
osascript -e '
tell application "Calendar"
  tell calendar "日历名称"
    set evts to (every event whose summary is "要删除的事件名")
    repeat with e in evts
      delete e
    end repeat
  end tell
end tell
'
```

---

## 打开原生应用

当用户想直接查看邮箱或日历时，用 `open` 命令跳转到原生 App：

```bash
# 打开 Mail.app
open -a "Mail"

# 打开 Calendar.app
open -a "Calendar"

# 打开 Calendar.app 并跳到指定日期
open "x-apple-calevent://"
```

---

## 常见问题

### AppleScript 超时
如果邮箱数据量大，搜索可能耗时较长。对 Bash 工具设置 `timeout: 30000`（30秒）。

### 日期格式
macOS AppleScript 日期格式跟随系统区域设置。中文系统通常接受：
- `date "2026-02-15"`
- `date "2026-02-15 14:00:00"`
- `date "2026年2月15日"`

如果日期解析出错，用这个格式：
```applescript
set d to current date
set year of d to 2026
set month of d to 2
set day of d to 15
set time of d to 14 * hours
```

### 首次访问权限
首次运行时 macOS 会弹出权限请求对话框（"允许终端/xxx 控制 Mail/Calendar"）。
用户需要在 **系统设置 → 隐私与安全性 → 自动化** 中授权。

### 邮件正文编码
`content of message` 返回纯文本。如果需要 HTML 版本：
```applescript
set htmlContent to source of message INDEX of inbox
```
但 HTML 很长，建议只在用户明确需要时使用。

---
description: Configure Telegram and Feishu bots (first-time setup)
---
Guide the user through setting up Telegram and/or Feishu for MetaMe.

## Telegram Setup

1. Ask: "Do you want to set up Telegram?" (Y/n)

2. If yes, guide them step by step:

   **Step 1: Create a Bot**
   - Open Telegram app on your phone or desktop
   - Search for `@BotFather` (official Telegram bot for creating bots)
   - Send `/newbot` command
   - BotFather will ask for a name (display name, e.g., "My MetaMe Bot")
   - Then ask for a username (must end in `bot`, e.g., `my_metame_bot`)
   - BotFather will reply with your **bot token** (looks like: `123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ`)
   - **Copy this token** — you'll need it

   **Step 2: Get Your Chat ID**
   - Open your new bot in Telegram (search for the username you just created)
   - Send any message to it (e.g., "hello")
   - Now we need to get your chat ID. Two options:
     - Option A: Search for `@userinfobot` in Telegram, start it, it will show your ID
     - Option B: Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser, find `"chat":{"id":123456789}`
   - Your chat ID is a number like `123456789`

3. Ask user to paste the bot token and chat ID

## Feishu Setup

1. Ask: "Do you want to set up Feishu (飞书)?" (Y/n)

2. If yes, guide them step by step:

   **Step 1: Create an App**
   - Go to Feishu Developer Console: https://open.feishu.cn/app
   - Click "创建企业自建应用" (Create Enterprise App)
   - Fill in app name and description
   - After creation, you'll be in the app dashboard

   **Step 2: Get Credentials**
   - In left sidebar, click "凭证与基础信息" (Credentials)
   - Copy **App ID** and **App Secret**

   **Step 3: Enable Bot**
   - In left sidebar, click "应用能力" → "机器人" (Bot)
   - Enable the bot capability

   **Step 4: Configure Events**
   - In left sidebar, click "事件订阅" (Event Subscription)
   - Choose "使用长连接接收事件" (Long Connection mode) — this is important!
   - Add event: `im.message.receive_v1` (接收消息)

   **Step 5: Add Permissions**
   - In left sidebar, click "权限管理" (Permissions)
   - Search and enable these 5 permissions:
     - `im:message` (获取与发送单聊、群组消息)
     - `im:message.p2p_msg:readonly` (读取用户发给机器人的单聊消息)
     - `im:message.group_at_msg:readonly` (接收群聊中@机器人消息事件)
     - `im:message:send_as_bot` (以应用的身份发消息)
     - `im:resource` (获取与上传图片或文件资源) — needed for file transfer

   **Step 6: Publish**
   - In left sidebar, click "版本管理与发布" (Version Management)
   - Click "创建版本" (Create Version)
   - Fill in version number (e.g., 1.0.0) and update notes
   - Click "申请发布" (Apply for Release)
   - If you're the admin, approve it; otherwise wait for admin approval

3. Ask user for App ID and App Secret

## Save Config

Write the configuration to ~/.metame/daemon.yaml:

```yaml
telegram:
  enabled: true/false
  bot_token: "..."
  allowed_chat_ids:
    - <chat_id>

feishu:
  enabled: true/false
  app_id: "..."
  app_secret: "..."
  allowed_chat_ids: []  # empty = allow all

heartbeat:
  tasks:
    - name: "daily-summary"
      prompt: "Summarize today's git commits"
      interval: "24h"
      notify: true  # push results to phone

budget:
  daily_limit: 50000
```

After saving, tell the user:
- Run `/metame:daemon-start` to start the daemon
- On phone, send any message to test the connection
- Use `/cd last` on phone to sync to your computer's latest session

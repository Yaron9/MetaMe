---
description: Configure Telegram and Feishu bots (first-time setup)
---
Guide the user through setting up Telegram and/or Feishu for MetaMe.

## Telegram Setup

1. Ask: "Do you want to set up Telegram?" (Y/n)

2. If yes, guide them:
   - Open Telegram, search @BotFather
   - Send /newbot, follow prompts to create a bot
   - Copy the bot token (looks like: 123456:ABC-DEF...)
   - Ask user to paste the token

3. Get their chat ID:
   - Tell them to send any message to their new bot
   - Use the Telegram API to fetch updates and extract chat_id
   - Or ask them to use @userinfobot to get their ID

## Feishu Setup

1. Ask: "Do you want to set up Feishu?" (Y/n)

2. If yes, guide them:
   - Go to: https://open.feishu.cn/app
   - Create App (企业自建应用)
   - In 'Credentials', copy App ID & App Secret
   - In 'Bot', enable bot capability
   - In 'Event Subscription', set to Long Connection mode
   - Add event: im.message.receive_v1
   - In 'Permissions', add these 5 permissions:
     - im:message (获取与发送单聊、群组消息)
     - im:message.p2p_msg:readonly (读取用户发给机器人的单聊消息)
     - im:message.group_at_msg:readonly (接收群聊中@机器人消息事件)
     - im:message:send_as_bot (以应用的身份发消息)
     - im:resource (获取与上传图片或文件资源 - for file transfer)
   - Publish the app version

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

After saving, tell the user to run /metame:daemon-start to start the daemon.

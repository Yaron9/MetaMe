# Feishu Topic Integration Implementation Plan

This plan documents the changes to integrate Feishu topic-based interaction (Threads/Topics) to allow per-topic session isolation ("一人一个话题 来隔离session").

## Problem Description
Currently, `daemon-bridges.js` tracks sessions per chat room (`chatId`). In a group chat, this causes multiple users or multiple workstreams to collide inside the same session context.
Feishu has formal support for "Topic Replies / Threads". We can use this to establish session isolation: when a user replies to an agent in a thread (or creates a topic), the unique `root_id` / `parent_id` of the thread will serve as an isolated "virtual chat room".

## Virtual `pipelineChatId` Design
We will introduce a composite ID format:
`thread:{chatId}:{threadMessageId}`
Where `threadMessageId` is the `root_id` of the thread (or `parent_id` if single reply).

- The `processMessage` pipeline will receive this `pipelineChatId`, thus strictly binding the LLM state, the agent `sticky` state, and the work context to the Feishu thread.
- The `feishu-adapter.js` will unpack `thread:chatId:msgId` back into its components and utilize the `client.im.message.reply` method instead of the generic chat message creation, thereby continuing the output inside the original user's topic thread.

## Proposed Changes

### 1. `scripts/feishu-adapter.js`
- **[MODIFY]** `feishu-adapter.js`
  - Introduce `parseChatId(cid)` to break up strings of the format `thread:cid:msgId`.
  - Update `sendMessage(chatId, text)`:
    - If it's a thread, use `client.im.message.reply({ path: { message_id }, data: { msg_type: 'text', content: ... } })`.
    - Else use existing logic.
  - Update `_sendInteractive(chatId, card)`:
    - Same logic, utilize `client.im.message.reply` when a thread ID is provided.
  - Update `sendFile(chatId, filePath, caption)`:
    - Support replying in thread when creating the file message.

### 2. `scripts/daemon-bridges.js`
- **[MODIFY]** `daemon-bridges.js` (`startFeishuBridge` function)
  - Extract thread root from the message event (`const threadId = msgEvent.root_id || msgEvent.parent_id || extractFeishuReplyMessageId(event)`).
  - Construct `pipelineChatId = threadId ? \`thread:\${chatId}:\${threadId}\` : chatId`.
  - Pass `pipelineChatId` to:
    - Session tracking (`getSession(pipelineChatId)`)
    - Sticky routing (`_chatKey = String(pipelineChatId)`)
    - Message pipelines (`pipeline.processMessage(pipelineChatId, ...)`)
    - Dispatch commands (`_dispatchToTeamMember(..., pipelineChatId, ...)`).
  - Leave exact configuration lookups (`_getBoundProject(chatId)`) and ACL checking (`applyUserAcl`) utilizing the original raw `chatId` so group permissions remain valid.

## Verification Plan

### Automated Tests
1. Run ESLint successfully (`npx eslint scripts/daemon-bridges.js scripts/feishu-adapter.js`).
2. Run unit tests (`node --test scripts/daemon-*.test.js` or `node --test scripts/feishu-adapter.test.js`) to ensure there are no regressions.

### Manual Verification
1. Since we do not have a live Feishu bot in our immediate test environment, and this involves Feishu interaction, I will start the daemon in local mode after applying changes or advise the user to test the capability.
2. The user will be asked to:
   - Mentions the bot in a group chat and start a thread.
   - Reply to the bot within the thread.
   - Verify that the bot stays isolated in that thread and its memory/sticky context is isolated from the main group.

---
name: agent-management
description: >
  MetaMe Agent lifecycle management — create, bind, list, edit, unbind agents.
  TRIGGER when: user explicitly requests creating a new agent, binding/unbinding
  an agent to a chat, listing agents, editing agent roles, resetting agents, or
  managing agent soul/identity. Keywords: "新建agent", "创建智能体", "绑定agent",
  "解绑", "agent列表", "/agent", "创建工作区".
  DO NOT TRIGGER when: user is DISCUSSING agents conceptually, talking ABOUT the
  agent system, reporting bugs about agents, or mentioning "agent" in passing
  without an actionable request. If the message is about agent architecture,
  design, code, or features — that is NOT a trigger.
---

# Agent Management

Manage MetaMe agents through `/agent` slash commands. Never edit `daemon.yaml` directly.

## Intent Discrimination (Critical)

Before acting, classify the user's message:

**ACTION** — user wants you to DO something with agents right now:
- "帮我创建一个agent负责代码审查"
- "给这个群绑定一个agent"
- "列出所有agent"
- "把当前agent解绑"
- "修改agent的角色为后端专家"

**DISCUSSION** — user is talking ABOUT agents, not requesting action:
- "创建agent的功能应该做成skill" (talking about the feature)
- "agent intent误触发了" (reporting a bug)
- "我觉得agent管理可以更优雅" (design discussion)
- "新建agent的流程需要改进" (meta-discussion)

**Rule: when in doubt, treat as DISCUSSION.** Only proceed with agent operations when intent is unambiguous. If uncertain, ask: "你是想让我现在创建一个agent，还是在讨论agent功能？"

## Command Reference

All operations use daemon-handled slash commands sent as regular messages:

| Command | Purpose |
|---------|---------|
| `/agent list` | List all configured agents with status |
| `/agent bind <name> <cwd>` | Create/bind agent to current chat |
| `/agent new` | Start interactive creation wizard |
| `/agent new clone` | Clone current agent to a new workspace |
| `/agent new team` | Create multi-member team workspace |
| `/agent edit <description>` | Merge role description into CLAUDE.md |
| `/agent reset` | Clear agent role section from CLAUDE.md |
| `/agent unbind` | Unbind agent from current chat |
| `/agent soul` | View current soul/identity |
| `/agent soul repair` | Repair soul layer files |
| `/agent soul edit <text>` | Overwrite SOUL.md content |
| `/activate` | Activate a pending agent in a new chat |

## Workflows

### Create Agent (One-Shot)

When the user provides enough info (name + purpose), skip the wizard:

1. Derive: agent name, workspace directory, role description, engine
2. Default workspace: `~/AGI/<agent-name>/` (use forward slashes on Mac, backslashes on Windows)
3. Send: `/agent bind <name> <cwd>` — this creates the project, registers in daemon.yaml, and binds to current chat
4. If user wants a role description, follow up with: `/agent edit <description>`
5. If user wants a SEPARATE Feishu chat for the agent, use `/agent new` wizard instead

### Create Agent (With Dedicated Chat)

When the user wants the agent in its own Feishu group:

1. Send: `/agent new` — starts the interactive wizard
2. The wizard will ask for: directory, name, description
3. Answer each wizard prompt based on user's requirements
4. After creation, the system auto-creates a Feishu chat and binds it (if permissions allow)
5. If auto-chat fails, tell user to `/activate` in the new chat within 30 minutes

### Quick Operations

- **List**: Send `/agent list` — shows all agents with bound status
- **Unbind**: Send `/agent unbind` — removes current chat binding
- **Edit role**: Send `/agent edit <full description>` — merges into workspace CLAUDE.md
- **Reset**: Send `/agent reset` — clears the Agent Role section

## Strict Chat Constraint

If the current chat is already bound to a specific agent (a "strict chat" — it has an entry
in `chat_agent_map`), then **do NOT** use `/agent bind`, `/agent unbind`, or `/activate` here.
These would break the fixed routing. Safe operations in strict chats: `/agent list`,
`/agent new` (creates elsewhere), `/agent edit`, `/agent soul`.

If the user wants to bind/unbind, tell them to do it in the target chat or create a new chat.

## Constraints

- All commands are sent as plain text messages — the daemon intercepts and handles them
- Never directly write to `daemon.yaml` or `~/.metame/` files for agent config
- YAML paths on Windows: always use single quotes to avoid escape issues (`'D:\path'` not `"D:\path"`)
- Agent names should be short, ASCII-safe identifiers (Chinese names work for display)
- One chat can only be bound to one agent at a time

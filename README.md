# 🔮 MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

> **The Meta-Cognitive Layer for Claude Code.**
>
> *Turn your AI assistant into a psychological mirror that knows you, evolves with you, and protects your core values.*

## 📖 Introduction

**Claude Code** is a powerful tool, but it suffers from "Project Amnesia." Every time you switch folders, it forgets who you are, your communication style, and your specific constraints.

**MetaMe** solves this by wrapping Claude in a  **Meta-Cognitive Layer** . It creates a persistent "Global Brain" that travels with you across every project. It knows your psychological profile, monitors your stress levels, and respects your core principles—without you having to repeat yourself.

It is not just a launcher; it is a  **Meta Avatar** .

## ✨ Key Features

* **🧠 Global Brain (`~/.claude_profile.yaml`):** A single source of truth for your identity, storing your nickname, stress status, and cognitive traits.
* **🧬 Evolution Mechanism:** You are in control. Use `!metame evolve` to manually teach Claude about your new preferences or constraints, ensuring it gets smarter with every interaction.
* **🤝 Dynamic Handshake Protocol:** The "Canary Test." MetaMe verifies its connection to your profile by addressing you by your chosen **Codename** in the very first sentence. If it doesn't, you know the link is broken.
* **🛡️ Auto-Lock Mechanism:** Mark any value in your profile with `# [LOCKED]`, and MetaMe will treat it as a constitution that cannot be overwritten.
* **🔌 Smart Injection:** Automatically injects your profile context into the `CLAUDE.md` of any project you enter, ensuring seamless context switching.

## 🛠 Prerequisites

MetaMe is a wrapper around **Claude Code**. You must have Node.js and the official Claude Code tool installed first.

1. **Node.js**: Version 14 or higher.
2. **Claude Code**: Ensure `claude` is available in your PATH and you are logged in.

## 📦 Installation

Install MetaMe globally via NPM:

**Bash**

```
npm install -g metame-cli
```

*(Note: If you encounter permission errors on Mac/Linux, use `sudo npm install -g metame-cli`)*

## 🚀 Usage

Forget the `claude` command. From now on, simply type:

**Bash**

```
metame
```

Or, if you prefer mixed case (it's the same command):

**Bash**

```
MetaMe
```

### The First Run (Genesis)

When you run MetaMe for the first time, it will detect that your profile is empty. It will pause the AI and enter **Calibration Mode**:

1. It will ask you for a **Codename** (Nickname).
2. It will initiate a **Deep Cognitive Interview** to map your talents, mental models, and hidden anxieties.
3. **Be Honest**: It acts as a mirror. The more raw truth you provide, the better it can shadow you.
4. Once finished, it saves your "Source Code" and launches Claude.

### Daily Workflow

1. `cd` into any project folder.
2. Run `metame`.
3. Claude will start and immediately say: *"Ready, [Your Name]..."*
4. Start coding. MetaMe manages the context in the background.

### Global Initialization (Reset/Interview)

If you want to restart the **Genesis Interview** to update your psychological profile:

**Bash**

```
metame interview
```
(Command to be implemented in v1.3 - currently you can manually edit `~/.claude_profile.yaml` or use `set-trait`)

### Surgical Update (Manual Override)

If you need to update a specific trait without editing the file manually:

**Bash**

```
metame set-trait status.focus "Learning Rust"
```

### Hot Reload (Refresh)

If you update your profile or need to fix a broken context **without restarting your session**:

*   **Inside Claude**: Run `!metame refresh`
*   **External Terminal**: Run `metame refresh`

This re-injects your latest profile into `CLAUDE.md` instantly.

## ⚙️ Configuration & The "Global Brain"

Your profile is stored in a hidden YAML file in your home directory.

**Location:** `~/.claude_profile.yaml`

You can edit this file manually to update your status or lock your values.

**Example Profile:**

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

* **`# [LOCKED]`** : Adding this comment ensures that even as the AI evolves your profile, these specific lines will **never** be changed.

## 🗑️ Uninstallation

If you wish to remove MetaMe completely from your system, follow these steps:

### 1. Remove the Package

Uninstall the CLI tool:

**Bash**

```
npm uninstall -g metame-cli
```

### 2. Remove the Global Brain (Optional)

If you want to delete your stored profile data:

**Bash**

```
rm ~/.claude_profile.yaml
```

### 3. Cleanup Project Files (Optional)

MetaMe adds a header to `CLAUDE.md` files in your projects. To restore them to their original state (if you have many), you can use a text editor to remove the block starting with `## 🧠 SYSTEM KERNEL`.

## ⚡ Performance & Cost

You might worry: *"Does this eat up my context window?"*

**Short answer: No. It likely saves you money.**

*   **Context Cost**: The entire MetaMe kernel + your profile takes up **~800-1000 tokens**.
*   **Impact**: On a 200k context window, this is **0.5%** of the memory.
*   **ROI**: By pre-loading your context, you avoid the "instructional drift" and repetitive correction loops that usually waste thousands of tokens at the start of every session.

## ❓ FAQ

**Q: Does this replace `CLAUDE.md`?**
A: No. It *prepends* its meta-cognitive protocol to your existing `CLAUDE.md`. Your project-specific notes remain intact.

**Q: What if Claude stops calling me by my nickname?**
A: This is the "Canary Test." It means the context window has been compressed or the file link is broken. Run `/compact` in Claude or restart `metame` to fix it.

**Q: Is my data sent to a third party?**
A: No. Your profile stays local at `~/.claude_profile.yaml`. MetaMe simply passes text to the official Claude Code tool.

## 📄 License

MIT License. Feel free to fork, modify, and evolve your own Meta-Cognition.

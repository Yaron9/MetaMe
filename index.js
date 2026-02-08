#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------
const HOME_DIR = os.homedir();
const BRAIN_FILE = path.join(HOME_DIR, '.claude_profile.yaml');
const PROJECT_FILE = path.join(process.cwd(), 'CLAUDE.md');
const METAME_DIR = path.join(HOME_DIR, '.metame');
const CLAUDE_SETTINGS = path.join(HOME_DIR, '.claude', 'settings.json');
const CLAUDE_MCP_CONFIG = path.join(HOME_DIR, '.claude', 'mcp.json'); // legacy, kept for reference
const SIGNAL_CAPTURE_SCRIPT = path.join(METAME_DIR, 'signal-capture.js');

// ---------------------------------------------------------
// 0. ONBOARDING STATE MANAGEMENT (New User Experience)
// ---------------------------------------------------------
const ONBOARDING_FILE = path.join(METAME_DIR, 'onboarding.json');

function getOnboardingState() {
  try {
    if (fs.existsSync(ONBOARDING_FILE)) {
      return JSON.parse(fs.readFileSync(ONBOARDING_FILE, 'utf8'));
    }
  } catch { }
  return { phase: 'none', qa_count: 0, collected: {} };
}

function setOnboardingState(state) {
  fs.writeFileSync(ONBOARDING_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function clearOnboardingState() {
  if (fs.existsSync(ONBOARDING_FILE)) {
    fs.unlinkSync(ONBOARDING_FILE);
  }
}

// Check if this is a new user (nickname is null or 'null')
function isNewUser() {
  try {
    if (!fs.existsSync(BRAIN_FILE)) return true;
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    const nickname = doc.identity?.nickname;
    return !nickname || nickname === 'null' || nickname === null;
  } catch { return true; }
}

// ---------------------------------------------------------
// 1.5 ENSURE METAME DIRECTORY + DEPLOY SCRIPTS
// ---------------------------------------------------------
if (!fs.existsSync(METAME_DIR)) {
  fs.mkdirSync(METAME_DIR, { recursive: true });
}

// Auto-deploy bundled scripts to ~/.metame/
const BUNDLED_SCRIPTS = ['signal-capture.js', 'distill.js', 'schema.js', 'pending-traits.js', 'migrate-v2.js', 'daemon.js', 'telegram-adapter.js', 'feishu-adapter.js', 'daemon-default.yaml', 'providers.js', 'session-analytics.js', 'resolve-yaml.js', 'utils.js'];
const scriptsDir = path.join(__dirname, 'scripts');

for (const script of BUNDLED_SCRIPTS) {
  const src = path.join(scriptsDir, script);
  const dest = path.join(METAME_DIR, script);
  try {
    if (fs.existsSync(src)) {
      const srcContent = fs.readFileSync(src, 'utf8');
      const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      if (srcContent !== destContent) {
        fs.writeFileSync(dest, srcContent, 'utf8');
      }
    }
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------
// 1.6 AUTO-INSTALL SIGNAL CAPTURE HOOK
// ---------------------------------------------------------
function ensureHookInstalled() {
  try {
    // Ensure ~/.claude/ exists
    const claudeDir = path.join(HOME_DIR, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    }

    // Check if our hook is already configured
    const hookCommand = `node ${SIGNAL_CAPTURE_SCRIPT}`;
    const existing = settings.hooks?.UserPromptSubmit || [];
    const alreadyInstalled = existing.some(entry =>
      entry.hooks?.some(h => h.command === hookCommand)
    );

    if (!alreadyInstalled) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

      settings.hooks.UserPromptSubmit.push({
        hooks: [{
          type: 'command',
          command: hookCommand
        }]
      });

      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
      console.log("🪝 MetaMe: Signal capture hook installed.");
    }
  } catch (e) {
    // Non-fatal: hook install failure shouldn't block launch
    console.error("⚠️  Hook install skipped:", e.message);
  }
}

ensureHookInstalled();

// ---------------------------------------------------------
// 1.6b ENSURE PROJECT-LEVEL MCP CONFIG
// ---------------------------------------------------------
// MCP servers are registered per-project via .mcp.json (not user-scope ~/.claude.json)
// so they only load when working in projects that need them.
// The daemon's heartbeat tasks use cwd: ~/AGI/Digital_Me which has its own .mcp.json.

// ---------------------------------------------------------
// 1.7 PASSIVE DISTILLATION (Background, post-launch)
// ---------------------------------------------------------
function shouldDistill() {
  const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
  if (!fs.existsSync(bufferFile)) return false;
  const content = fs.readFileSync(bufferFile, 'utf8').trim();
  return content.length > 0;
}

function needsBootstrap() {
  try {
    const sessionLogFile = path.join(METAME_DIR, 'session_log.yaml');
    if (!fs.existsSync(sessionLogFile)) return true;
    const yaml = require('js-yaml');
    const log = yaml.load(fs.readFileSync(sessionLogFile, 'utf8'));
    return !log || !Array.isArray(log.sessions) || log.sessions.length < 5;
  } catch { return true; }
}

function spawnDistillBackground() {
  const distillPath = path.join(METAME_DIR, 'distill.js');
  if (!fs.existsSync(distillPath)) return;

  const hasSignals = shouldDistill();
  const bootstrap = needsBootstrap();

  if (!hasSignals && !bootstrap) return;

  if (hasSignals) {
    const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
    const lines = fs.readFileSync(bufferFile, 'utf8').trim().split('\n').filter(l => l.trim());
    console.log(`🧠 MetaMe: Distilling ${lines.length} moment${lines.length > 1 ? 's' : ''} in background...`);
  }
  if (bootstrap) {
    console.log('📊 MetaMe: Bootstrapping session history...');
  }

  // Spawn as detached background process — won't block Claude launch
  const bg = spawn('node', [distillPath], {
    detached: true,
    stdio: 'ignore'
  });
  bg.unref();
}

// ---------------------------------------------------------
// 1.8 TIME-BASED EXPIRY (Startup cleanup)
// ---------------------------------------------------------
function runExpiryCleanup() {
  try {
    const yaml = require('js-yaml');
    if (!fs.existsSync(BRAIN_FILE)) return;

    const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    const profile = yaml.load(rawProfile);
    if (!profile || typeof profile !== 'object') return;

    const now = Date.now();
    let changed = false;

    // context.focus: if focus_since > 30 days, auto-clear
    if (profile.context && profile.context.focus_since) {
      const focusSince = new Date(profile.context.focus_since).getTime();
      if (now - focusSince > 30 * 24 * 60 * 60 * 1000) {
        profile.context.focus = null;
        profile.context.focus_since = null;
        changed = true;
      }
    }

    // context.blockers: if > 14 days, auto-clear
    // (blockers are arrays — clear entire array if stale)
    if (profile.context && Array.isArray(profile.context.blockers) && profile.context.blockers.length > 0) {
      // If we don't have a blockers_since timestamp, just leave them
      // Future: add per-item timestamps
    }

    // context.energy: reset to null on each session start
    if (profile.context && profile.context.energy !== undefined) {
      if (profile.context.energy !== null) {
        profile.context.energy = null;
        changed = true;
      }
    }

    if (changed) {
      // Preserve comments
      const commentMatch = rawProfile.match(/^(\s*[\w_]+\s*:.+?)\s+(#.+)$/gm);
      const dumped = yaml.dump(profile, { lineWidth: -1 });
      fs.writeFileSync(BRAIN_FILE, dumped, 'utf8');
    }

    // Expire stale pending traits
    const pendingFile = path.join(METAME_DIR, 'pending_traits.yaml');
    if (fs.existsSync(pendingFile)) {
      const pending = yaml.load(fs.readFileSync(pendingFile, 'utf8')) || {};
      const cutoff = 30 * 24 * 60 * 60 * 1000;
      let expiredCount = 0;
      for (const [key, meta] of Object.entries(pending)) {
        if (meta.last_seen) {
          const lastSeen = new Date(meta.last_seen).getTime();
          if (now - lastSeen > cutoff) {
            delete pending[key];
            expiredCount++;
          }
        }
      }
      if (expiredCount > 0) {
        fs.writeFileSync(pendingFile, yaml.dump(pending, { lineWidth: -1 }), 'utf8');
      }
    }
  } catch {
    // Non-fatal — expiry cleanup failure shouldn't block launch
  }
}

runExpiryCleanup();

// ---------------------------------------------------------
// 2. BRAIN INITIALIZATION (Cold Start)
// ---------------------------------------------------------
// Ensure the Brain exists.
if (!fs.existsSync(BRAIN_FILE)) {
  const initialProfile = `identity:
  role: Unknown
  nickname: null
status:
  focus: Initializing
`;
  fs.writeFileSync(BRAIN_FILE, initialProfile, 'utf8');
}

// ---------------------------------------------------------
// 3. DEFINE SYSTEM KERNEL (The Protocol)
// ---------------------------------------------------------
const CORE_PROTOCOL = `
---
## 🧠 SYSTEM KERNEL: SHADOW_MODE (Active)

**1. THE BRAIN (Source of Truth):**
   * **FILE:** \`$HOME/.claude_profile.yaml\`
   * **RULE:** This file is your Ground Truth. If context is compressed (/compact), **RE-READ** this file immediately.
   * **AUTO-LOCK:** Never edit lines marked \`# [LOCKED]\` (Core Values).
   * **EVOLUTION:** Silently overwrite outdated status/focus.

**2. EVOLUTION MECHANISM (Manual Sync):**
   *   **PHILOSOPHY:** You respect the User's flow. You do NOT interrupt.
   *   **TOOLS:**
       1. **Log Insight:** \`!metame evolve "Insight"\` (For additive knowledge).
       2. **Surgical Update:** \`!metame set-trait key value\` (For overwriting specific fields, e.g., \`!metame set-trait status.focus "API Design"\`).
   *   **RULE:** Only use these tools when the User **EXPLICITLY** instructs you.
   *   **REMINDER:** If the User expresses a strong persistent preference, you may gently ask *at the end of the task*: "Should I save this preference to your MetaMe profile?"
---
`;

const INTERVIEW_PROTOCOL = `
---
## 🎯 ONBOARDING: INTERVIEW MODE

**IMPORTANT:** You are in INTERVIEW MODE. Your only job is to ask ONE deep question, then STOP and wait for the user's answer.

**RULES (STRICT):**
1. Ask ONLY ONE question at a time. Never ask multiple questions in one response.
2. After your question, you MUST stop. Do not provide additional context, examples, or follow-up questions.
3. Wait for the user's response before asking the next question.
4. Keep questions open-ended (not multiple choice).

**THE INTERVIEW FLOW:**

**STEP 1 - Trust Building:**
Ask: "在开始之前，我想先了解你。为了成为你真正的认知镜像，我需要你最真实、不加修饰的回答。你准备好了吗？"

(Wait for confirmation)

**STEP 2 - Current Context:**
Ask ONE question about what they're currently working on or trying to achieve.

**STEP 3 - Cognitive Style:**
Based on their answer, ask ONE question about how they think/work.

**STEP 4 - Values & Preferences:**
Ask ONE question about what matters most to them (speed vs quality, precision vs impact, etc.).

**STEP 5 - Challenges:**
Ask ONE question about what challenges or fears they face.

**STEP 6 - Nickname:**
Finally ask: "我们快完成了。我应该怎么称呼你？（你的昵称或名字）"

**STEP 7 - Completion:**
Once you have their nickname, say:
"谢谢你！采访完成。我现在需要一点点时间来整理这些信息，然后引导你完成最后的设置。"

Then STOP. Do not say anything else. The system will transition you to SETUP MODE.

---

## ⚙️ ONBOARDING: SETUP MODE

**IMPORTANT:** You are now in SETUP MODE. Guide the user through configuring mobile access.

**RULES:**
1. Explain each step clearly.
2. Do NOT ask them to run terminal commands — provide instructions they can follow.
3. Ask them to paste configuration values when needed.
4. Be encouraging and supportive.

**THE SETUP FLOW:**

1. **Greet & Confirm:**
"采访完成！我现在对你的工作方式、思维模式和核心价值有了全面的了解。"

2. **Explain Mobile Access:**
"想随时随地和我对话吗？通过手机端的 Telegram 或飞书，你可以：随时唤醒我、查看文件、继续工作。"

3. **Telegram Setup Instructions:**
"如果你想用 Telegram：
1. 打开 Telegram，搜索 @BotFather
2. 点击 Start，输入 /newbot
3. 给你的 bot 取个名字（比如 'MyMetaMe'）
4. BotFather 会返回一个 token，格式像这样：123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
5. 把这个 token 发送给我，我来完成配置"

4. **Wait for token:**
Wait for user to paste their Telegram bot token.

5. **Chat ID Instructions:**
"还需要你的 Telegram Chat ID：
1. 搜索 @userinfobot
2. 点击 Start
3. 它会显示你的 ID（一个数字）
4. 把这个数字也发给我"

6. **Wait for Chat ID:**
Wait for user to paste their Chat ID.

7. **Feishu Alternative (Optional):**
"或者你也可以用飞书。需要配置应用 ID、应用密钥和 Chat ID。如果你更倾向于飞书，告诉我，我给你详细步骤。"

8. **Completion:**
"配置完成！现在你可以通过手机端的 Telegram 随时唤醒我了。有什么想问的吗？"

Then continue normal conversation.

---
`;

const SETUP_PROTOCOL = `
## ⚙️ SETUP MODE (Mobile Access Configuration)

**IMPORTANT:** You are in SETUP MODE. Guide the user through configuring mobile access to MetaMe.

**RULES:**
1. Explain each step clearly and simply.
2. Do NOT ask them to run terminal commands — provide instructions they can follow.
3. Ask them to paste configuration values when needed.
4. Be encouraging and supportive.

**YOUR GOAL:** Help the user configure Telegram OR Feishu so they can access MetaMe from their phone.

**THE SETUP FLOW:**

1. **Greet & Confirm:**
"采访完成！我现在对你的工作方式、思维模式和核心价值有了全面的了解。"

2. **Explain Mobile Access:**
"想随时随地和我对话吗？通过手机端的 Telegram 或飞书，你可以：
• 随时唤醒我，继续我们的对话
• 查看和下载项目文件
• 运行心跳任务，接收自动化结果

以下是用 Telegram 配置的步骤："

3. **Step-by-Step Telegram Instructions:**
"📱 Telegram 配置步骤：

**第一步：创建 Bot**
1. 打开 Telegram，搜索 @BotFather
2. 点击 Start
3. 发送 /newbot
4. 给你的 bot 取个名字（比如 'MyMetaMe'）
5. 再取个 username（必须是英文结尾，比如 'MyMetaMe_bot'）
6. BotFather 会返回一个 token，格式像这样：123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
7. **把这个 token 复制粘贴发给我**

**第二步：获取 Chat ID**
1. 搜索 @userinfobot
2. 点击 Start
3. 它会显示一串数字，那就是你的 Chat ID
4. **把这个数字也发给我**

发送完成后，我会自动完成配置！"

4. **Wait for User Input:**
Wait for the user to paste their bot token and Chat ID. You don't need to validate — the system will handle that.

5. **Feishu Alternative:**
"或者你也可以用飞书。如果你想用飞书，告诉我，我可以给你详细的配置步骤。"

6. **If User Asks for Feishu:**
"📱 飞书配置步骤：

**第一步：在飞书开放平台创建应用**
1. 打开 https://open.feishu.cn/
2. 点击"创建企业自建应用"
3. 填写应用名称（如 'MetaMe'）和描述
4. 创建后，在应用页面获取 App ID 和 App Secret

**第二步：配置应用权限**
在应用的功能页面，开通以下权限：
- im:message
- im:message.resource
- im:chat

**第三步：发布版本**
1. 点击"版本管理与发布"
2. 创建新版本并填写版本信息
3. 发布版本（选择"全员工"或指定成员）

**第四步：获取 Chat ID**
在飞书群里@你的应用，获取 Chat ID。

把这些信息（App ID、App Secret、Chat ID）发给我，我来完成配置！"

7. **Completion Message:**
"✅ 配置完成！MetaMe 已准备就绪。

你可以：
• 打开 Telegram，搜索你的 bot（你之前创建的 username）
• 点击 Start，开始对话！
• 随时随地唤醒我，继续我们的工作

有什么想问的吗？或者我们开始工作吧！"

After completion, continue normal conversation.

---

## ✅ ONBOARDING: WIZARD COMPLETE

Once you have successfully configured Telegram or Feishu (user has provided bot token and chat ID, or confirmed they're done), say:

"✅ 配置完成！MetaMe 已准备就绪。

你可以：
• 随时在手机上通过 Telegram/飞书唤醒我
• 在任何设备上继续我们的对话
• 让我帮你分析、写作、编程

有什么想问的吗？或者我们开始工作吧！"

Then continue normal conversation as MetaMe.

---
`;

// ---------------------------------------------------------
// 4. INJECT PROTOCOL (Smart Update)
// ---------------------------------------------------------
let fileContent = "";

// Read existing CLAUDE.md if it exists
if (fs.existsSync(PROJECT_FILE)) {
  fileContent = fs.readFileSync(PROJECT_FILE, 'utf8');

  // Robust Regex: Removes any existing "## 🧠 SYSTEM KERNEL" block down to the separator
  fileContent = fileContent.replace(/## 🧠 SYSTEM KERNEL[\s\S]*?---\n/g, '');

  // Clean up any leading newlines left over
  fileContent = fileContent.replace(/^\n+/, '');
}

// Logic: Smart protocol injection based on onboarding state
let finalProtocol = CORE_PROTOCOL;
const yaml = require('js-yaml');

// Check current user state
let isKnownUser = false;
let needsWizard = false;
try {
  if (fs.existsSync(BRAIN_FILE)) {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    const nickname = doc.identity?.nickname;
    if (nickname && nickname !== 'null' && nickname !== null) {
      isKnownUser = true;
      // Check if wizard has been completed
      const onboarding = getOnboardingState();
      if (onboarding.phase !== 'completed') {
        needsWizard = true;
      }
    }
  }
} catch (e) {
  // Ignore error, treat as unknown
}

if (!isKnownUser) {
  // NEW USER → Inject INTERVIEW protocol
  finalProtocol = finalProtocol.replace('**2. EVOLUTION MECHANISM', INTERVIEW_PROTOCOL + '\n**2. EVOLUTION MECHANISM');
  console.log("🆕 新用户检测：进入采访模式...");
  console.log("   Claude 将一句一句提问，了解你的工作方式和思维模式。");
} else if (needsWizard) {
  // KNOWN USER but wizard not done → Inject SETUP protocol
  finalProtocol = finalProtocol.replace('**2. EVOLUTION MECHANISM', SETUP_PROTOCOL + '\n**2. EVOLUTION MECHANISM');
  console.log("⚙️  采访完成：进入设置向导...");
  console.log("   Claude 将引导你配置手机端访问（Telegram/飞书）。");
} else {
  // KNOWN USER + wizard done → Normal mode
  // Remove any existing onboarding protocol remnants
  finalProtocol = finalProtocol.replace(/## 🎯 ONBOARDING[\s\S]*?---\n/g, '');
  finalProtocol = finalProtocol.replace(/## ⚙️ ONBOARDING[\s\S]*?---\n/g, '');
}

// ---------------------------------------------------------
// 4.5 MIRROR INJECTION (Phase C — metacognition observation)
// ---------------------------------------------------------
let mirrorLine = '';
try {
  if (isKnownUser && fs.existsSync(BRAIN_FILE)) {
    const brainDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

    // Check quiet mode
    const quietUntil = brainDoc.growth && brainDoc.growth.quiet_until;
    const isQuiet = quietUntil && new Date(quietUntil).getTime() > Date.now();

    // Check mirror enabled (default: true)
    const mirrorEnabled = !(brainDoc.growth && brainDoc.growth.mirror_enabled === false);

    if (!isQuiet && mirrorEnabled && brainDoc.growth && Array.isArray(brainDoc.growth.patterns)) {
      const now = Date.now();
      const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

      // Find a pattern that hasn't been surfaced in 14 days
      const candidate = brainDoc.growth.patterns.find(p => {
        if (!p.surfaced) return true;
        return (now - new Date(p.surfaced).getTime()) > COOLDOWN_MS;
      });

      if (candidate) {
        mirrorLine = `\n[MetaMe observation: ${candidate.summary} 不要主动提起，只在用户自然提到相关话题时温和回应。]\n`;

        // Mark as surfaced
        candidate.surfaced = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(BRAIN_FILE, yaml.dump(brainDoc, { lineWidth: -1 }), 'utf8');
      }

      // Drift mirror fallback — when no pattern candidate, check recent session drift
      if (!candidate) {
        const sessionLogFile = path.join(METAME_DIR, 'session_log.yaml');
        if (fs.existsSync(sessionLogFile)) {
          const log = yaml.load(fs.readFileSync(sessionLogFile, 'utf8'));
          if (log && Array.isArray(log.sessions)) {
            const recent = log.sessions.slice(-3);
            const driftCount = recent.filter(s =>
              s.goal_alignment === 'drifted' || s.goal_alignment === 'partial'
            ).length;
            if (driftCount >= 2 && recent.length >= 2) {
              const projects = [...new Set(recent.map(s => s.project).filter(Boolean))];
              const declaredFocus = brainDoc.status?.focus || brainDoc.context?.focus;
              if (declaredFocus && projects.length > 0) {
                mirrorLine = `\n[MetaMe observation: 最近${driftCount}个session都在${projects.join(',')}上，和声明的目标"${declaredFocus}"有偏差。不要主动提起，只在用户自然提到相关话题时温和回应。]\n`;
              }
            }
          }
        }
      }
    }
  }
} catch {
  // Non-fatal
}

// ---------------------------------------------------------
// 4.6 REFLECTION PROMPT (Phase C — conditional, NOT static)
// ---------------------------------------------------------
// Only inject when trigger conditions are met at startup.
// This ensures reflections don't fire every session.
let reflectionLine = '';
try {
  if (isKnownUser && fs.existsSync(BRAIN_FILE)) {
    const refDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

    // Check quiet mode
    const quietUntil = refDoc.growth && refDoc.growth.quiet_until;
    const isQuietForRef = quietUntil && new Date(quietUntil).getTime() > Date.now();

    if (!isQuietForRef) {
      const distillCount = (refDoc.evolution && refDoc.evolution.distill_count) || 0;
      const zoneHistory = (refDoc.growth && refDoc.growth.zone_history) || [];

      // Trigger 1: Every 7th session
      const trigger7th = distillCount > 0 && distillCount % 7 === 0;

      // Trigger 2: Three consecutive comfort-zone sessions
      const lastThree = zoneHistory.slice(-3);
      const triggerComfort = lastThree.length === 3 && lastThree.every(z => z === 'C');

      // Trigger 3: Persistent goal drift (2+ drifted in last 3 sessions)
      let triggerDrift = false;
      let driftDeclaredFocus = null;
      try {
        const sessionLogFile = path.join(METAME_DIR, 'session_log.yaml');
        if (fs.existsSync(sessionLogFile)) {
          const driftLog = yaml.load(fs.readFileSync(sessionLogFile, 'utf8'));
          if (driftLog && Array.isArray(driftLog.sessions)) {
            const recentSessions = driftLog.sessions.slice(-3);
            const driftCount = recentSessions.filter(s =>
              s.goal_alignment === 'drifted' || s.goal_alignment === 'partial'
            ).length;
            if (driftCount >= 2 && recentSessions.length >= 2) {
              driftDeclaredFocus = refDoc.status?.focus || refDoc.context?.focus;
              if (driftDeclaredFocus) triggerDrift = true;
            }
          }
        }
      } catch { /* non-fatal */ }

      if (triggerDrift || triggerComfort || trigger7th) {
        let hint = '';
        if (triggerDrift) {
          hint = `最近几个session的方向和"${driftDeclaredFocus}"有偏差。请在对话开始时温和地问：🪞 是方向有意调整了，还是不小心偏了？`;
        } else if (triggerComfort) {
          hint = '连续几次都在熟悉领域。如果用户在session结束时自然停顿，可以温和地问：🪞 准备好探索拉伸区了吗？';
        } else {
          hint = '这是第' + distillCount + '次session。如果session自然结束，可以附加一句：🪞 一个词形容这次session的感受？';
        }
        const timing = triggerDrift ? '在对话开始时就问一次' : '只在session即将结束时说一次';
        reflectionLine = `\n[MetaMe reflection: ${hint} ${timing}。如果用户没回应就不要追问。]\n`;
      }
    }
  }
} catch {
  // Non-fatal
}

// Prepend the new Protocol to the top
const newContent = finalProtocol + mirrorLine + reflectionLine + "\n" + fileContent;
fs.writeFileSync(PROJECT_FILE, newContent, 'utf8');

console.log("🔮 MetaMe: Link Established.");
console.log("🧬 Protocol: Dynamic Handshake Active");

// ---------------------------------------------------------
// 5. LAUNCH CLAUDE (OR HOT RELOAD)
// ---------------------------------------------------------

// Check for "refresh" command (Hot Reload)
const isRefresh = process.argv.includes('refresh') || process.argv.includes('--refresh');

if (isRefresh) {
  console.log("✅ MetaMe configuration re-injected.");
  console.log("   Ask Claude to 'read CLAUDE.md' to apply the changes.");
  process.exit(0);
}

// Check for "evolve" command (Manual Evolution)
const isEvolve = process.argv.includes('evolve');

if (isEvolve) {
  const yaml = require('js-yaml');

  // Extract insight: everything after "evolve"
  const evolveIndex = process.argv.indexOf('evolve');
  const insight = process.argv.slice(evolveIndex + 1).join(' ').trim();

  if (!insight) {
    console.error("❌ Error: Missing insight.");
    console.error("   Usage: metame evolve \"I realized I prefer functional programming\"");
    process.exit(1);
  }

  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

      // Initialize evolution log if missing
      if (!doc.evolution) doc.evolution = {};
      if (!doc.evolution.log) doc.evolution.log = [];

      // Add timestamped entry
      doc.evolution.log.push({
        timestamp: new Date().toISOString(),
        insight: insight
      });

      // Save back to file
      fs.writeFileSync(BRAIN_FILE, yaml.dump(doc), 'utf8');

      console.log("🧠 MetaMe Brain Updated.");
      console.log(`   Added insight: "${insight}"`);
      console.log("   (Run 'metame refresh' to apply this to the current session)");
    } else {
      console.error("❌ Error: No profile found. Run 'metame' first to initialize.");
    }
  } catch (e) {
    console.error("❌ Error updating profile:", e.message);
  }
  process.exit(0);
}

// Check for "set-trait" command (Surgical Update)
const isSetTrait = process.argv.includes('set-trait');

if (isSetTrait) {
  const yaml = require('js-yaml');

  // Syntax: metame set-trait <key> <value>
  // Example: metame set-trait identity.role "Engineering Manager"

  const setIndex = process.argv.indexOf('set-trait');
  const key = process.argv[setIndex + 1];
  // Join the rest as the value (allows spaces)
  const value = process.argv.slice(setIndex + 2).join(' ').trim();

  if (!key || !value) {
    console.error("❌ Error: Missing key or value.");
    console.error("   Usage: metame set-trait identity.role \"New Role\"");
    process.exit(1);
  }

  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const rawContent = fs.readFileSync(BRAIN_FILE, 'utf8');
      const doc = yaml.load(rawContent) || {};

      // Helper to set nested property
      const setNested = (obj, path, val) => {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]]) current[keys[i]] = {};
          current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = val;
      };

      // Set the value
      setNested(doc, key, value);

      fs.writeFileSync(BRAIN_FILE, yaml.dump(doc), 'utf8');

      console.log(`🧠 MetaMe Brain Surgically Updated.`);
      console.log(`   Set \`${key}\` = "${value}"`);
      console.log("   (Run 'metame refresh' to apply this to the current session)");
    } else {
      console.error("❌ Error: No profile found.");
    }
  } catch (e) {
    console.error("❌ Error updating profile:", e.message);
  }
  process.exit(0);
}

// ---------------------------------------------------------
// 5.5 METACOGNITION CONTROL COMMANDS (Phase C)
// ---------------------------------------------------------

// metame quiet — silence mirror + reflections for 48 hours
const isQuiet = process.argv.includes('quiet');
if (isQuiet) {
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    if (!doc.growth) doc.growth = {};
    doc.growth.quiet_until = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
    console.log("🤫 MetaMe: Mirror & reflections silenced for 48 hours.");
  } catch (e) {
    console.error("❌ Error:", e.message);
  }
  process.exit(0);
}

// metame insights — show detected patterns
const isInsights = process.argv.includes('insights');
if (isInsights) {
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    const patterns = (doc.growth && doc.growth.patterns) || [];
    const zoneHistory = (doc.growth && doc.growth.zone_history) || [];

    if (patterns.length === 0) {
      console.log("🔍 MetaMe: No patterns detected yet. Keep using MetaMe and patterns will emerge after ~5 sessions.");
    } else {
      console.log("🪞 MetaMe Insights:\n");
      patterns.forEach((p, i) => {
        const icon = p.type === 'avoidance' ? '⚠️' : p.type === 'growth' ? '🌱' : p.type === 'energy' ? '⚡' : '🔄';
        console.log(`   ${icon} [${p.type}] ${p.summary} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
        console.log(`      Detected: ${p.detected}${p.surfaced ? `, Last shown: ${p.surfaced}` : ''}`);
      });
      if (zoneHistory.length > 0) {
        console.log(`\n   📊 Recent zone history: ${zoneHistory.join(' → ')}`);
        console.log(`      (C=Comfort, S=Stretch, P=Panic)`);
      }
      const answered = (doc.growth && doc.growth.reflections_answered) || 0;
      const skipped = (doc.growth && doc.growth.reflections_skipped) || 0;
      if (answered + skipped > 0) {
        console.log(`\n   💭 Reflections: ${answered} answered, ${skipped} skipped`);
      }
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
  }
  process.exit(0);
}

// metame mirror on/off — toggle mirror injection
const isMirror = process.argv.includes('mirror');
if (isMirror) {
  const mirrorIndex = process.argv.indexOf('mirror');
  const toggle = process.argv[mirrorIndex + 1];
  if (toggle !== 'on' && toggle !== 'off') {
    console.error("❌ Usage: metame mirror on|off");
    process.exit(1);
  }
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    if (!doc.growth) doc.growth = {};
    doc.growth.mirror_enabled = (toggle === 'on');
    fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
    console.log(`🪞 MetaMe: Mirror ${toggle === 'on' ? 'enabled' : 'disabled'}.`);
  } catch (e) {
    console.error("❌ Error:", e.message);
  }
  process.exit(0);
}

// ---------------------------------------------------------
// 5.6 PROVIDER SUBCOMMANDS
// ---------------------------------------------------------
const isProvider = process.argv.includes('provider');
if (isProvider) {
  const providers = require(path.join(__dirname, 'scripts', 'providers.js'));
  const providerIndex = process.argv.indexOf('provider');
  const subCmd = process.argv[providerIndex + 1];

  if (!subCmd || subCmd === 'list') {
    const active = providers.getActiveProvider();
    console.log(`🔌 MetaMe Providers (active: ${active ? active.name : 'anthropic'})`);
    console.log(providers.listFormatted());
    process.exit(0);
  }

  if (subCmd === 'use') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error("❌ Usage: metame provider use <name>");
      process.exit(1);
    }
    try {
      providers.setActive(name);
      const p = providers.getActiveProvider();
      console.log(`✅ Provider switched → ${name} (${p.label || name})`);
      if (name !== 'anthropic') {
        console.log(`   Base URL: ${p.base_url || 'not set'}`);
      }
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subCmd === 'add') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error("❌ Usage: metame provider add <name>");
      process.exit(1);
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    (async () => {
      console.log(`\n🔌 Add Provider: ${name}\n`);
      console.log("The relay must accept Anthropic Messages API format.");
      console.log("(Most quality relays like OpenRouter, OneAPI, etc. support this.)\n");

      const label = (await ask("Display name (e.g. OpenRouter): ")).trim() || name;
      const base_url = (await ask("Base URL (e.g. https://openrouter.ai/api/v1): ")).trim();
      const api_key = (await ask("API Key: ")).trim();

      if (!base_url) {
        console.error("❌ Base URL is required.");
        rl.close();
        process.exit(1);
      }

      const config = { label };
      if (base_url) config.base_url = base_url;
      if (api_key) config.api_key = api_key;

      try {
        providers.addProvider(name, config);
        console.log(`\n✅ Provider "${name}" added.`);
        console.log(`   Switch to it: metame provider use ${name}`);
      } catch (e) {
        console.error(`❌ ${e.message}`);
      }
      rl.close();
      process.exit(0);
    })();
    return; // Prevent further execution while async runs
  }

  if (subCmd === 'remove') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error("❌ Usage: metame provider remove <name>");
      process.exit(1);
    }
    try {
      providers.removeProvider(name);
      console.log(`✅ Provider "${name}" removed.`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
    }
    process.exit(0);
  }

  if (subCmd === 'set-role') {
    const role = process.argv[providerIndex + 2]; // distill | daemon
    const name = process.argv[providerIndex + 3]; // provider name or empty to clear
    if (!role) {
      console.error("❌ Usage: metame provider set-role <distill|daemon> [provider-name]");
      console.error("   Omit provider name to reset to active provider.");
      process.exit(1);
    }
    try {
      providers.setRole(role, name || null);
      console.log(`✅ ${role} provider ${name ? `set to "${name}"` : 'reset to active'}.`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
    }
    process.exit(0);
  }

  if (subCmd === 'test') {
    const targetName = process.argv[providerIndex + 2];
    const prov = providers.loadProviders();
    const name = targetName || prov.active;
    const p = prov.providers[name];
    if (!p) {
      console.error(`❌ Provider "${name}" not found.`);
      process.exit(1);
    }

    console.log(`🔍 Testing provider: ${name} (${p.label || name})`);
    if (name === 'anthropic') {
      console.log("   Using official Anthropic endpoint — testing via claude CLI...");
    } else {
      console.log(`   Base URL: ${p.base_url || 'not set'}`);
    }

    try {
      const env = { ...process.env, ...providers.buildEnv(name) };
      const { execSync } = require('child_process');
      const start = Date.now();
      const result = execSync(
        'claude -p --model haiku --no-session-persistence',
        {
          input: 'Respond with exactly: PROVIDER_OK',
          encoding: 'utf8',
          timeout: 30000,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      ).trim();
      const elapsed = Date.now() - start;

      if (result.includes('PROVIDER_OK')) {
        console.log(`   ✅ Connected (${elapsed}ms)`);
      } else {
        console.log(`   ⚠️  Response received (${elapsed}ms) but unexpected: ${result.slice(0, 80)}`);
      }
    } catch (e) {
      console.error(`   ❌ Failed: ${e.message.split('\n')[0]}`);
    }
    process.exit(0);
  }

  // Unknown subcommand — show help
  console.log("🔌 MetaMe Provider Commands:");
  console.log("   metame provider              — list providers");
  console.log("   metame provider use <name>   — switch active provider");
  console.log("   metame provider add <name>   — add a new provider");
  console.log("   metame provider remove <name> — remove provider");
  console.log("   metame provider test [name]  — test connectivity");
  console.log("   metame provider set-role <distill|daemon> [name]");
  console.log("                                — assign provider for background tasks");
  process.exit(0);
}

// ---------------------------------------------------------
// 5.7 DAEMON SUBCOMMANDS
// ---------------------------------------------------------
// Shorthand aliases: `metame start` → `metame daemon start`, etc.
const DAEMON_SHORTCUTS = ['start', 'stop', 'status', 'logs'];
if (DAEMON_SHORTCUTS.includes(process.argv[2])) {
  process.argv.splice(2, 0, 'daemon');
}
const isDaemon = process.argv.includes('daemon');
if (isDaemon) {
  const daemonIndex = process.argv.indexOf('daemon');
  const subCmd = process.argv[daemonIndex + 1];
  const DAEMON_CONFIG = path.join(METAME_DIR, 'daemon.yaml');
  const DAEMON_STATE = path.join(METAME_DIR, 'daemon_state.json');
  const DAEMON_PID = path.join(METAME_DIR, 'daemon.pid');
  const DAEMON_LOG = path.join(METAME_DIR, 'daemon.log');
  const DAEMON_DEFAULT = path.join(__dirname, 'scripts', 'daemon-default.yaml');
  const DAEMON_SCRIPT = path.join(METAME_DIR, 'daemon.js');

  if (subCmd === 'init') {
    (async () => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    // Create config from template if not exists
    if (!fs.existsSync(DAEMON_CONFIG)) {
      const templateSrc = fs.existsSync(DAEMON_DEFAULT)
        ? DAEMON_DEFAULT
        : path.join(METAME_DIR, 'daemon-default.yaml');
      if (fs.existsSync(templateSrc)) {
        fs.copyFileSync(templateSrc, DAEMON_CONFIG);
      } else {
        console.error("❌ Template not found. Reinstall MetaMe.");
        process.exit(1);
      }
      try { fs.chmodSync(METAME_DIR, 0o700); } catch { /* ignore on Windows */ }
      console.log("✅ Config created: ~/.metame/daemon.yaml\n");
    } else {
      console.log("✅ Config exists: ~/.metame/daemon.yaml\n");
    }

    const yaml = require(path.join(__dirname, 'node_modules', 'js-yaml'));
    let cfg = yaml.load(fs.readFileSync(DAEMON_CONFIG, 'utf8')) || {};

    // --- Telegram Setup ---
    console.log("━━━ 📱 Telegram Setup ━━━");
    console.log("");
    console.log("Step 1: Create a Bot");
    console.log("  • Open Telegram app on your phone or desktop");
    console.log("  • Search for @BotFather (official Telegram bot)");
    console.log("  • Send /newbot command");
    console.log("  • Enter a display name (e.g., 'My MetaMe Bot')");
    console.log("  • Enter a username (must end in 'bot', e.g., 'my_metame_bot')");
    console.log("  • BotFather will reply with your bot token");
    console.log("    (looks like: 123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ)");
    console.log("");

    const tgToken = (await ask("Paste your Telegram bot token (Enter to skip): ")).trim();
    if (tgToken) {
      if (!cfg.telegram) cfg.telegram = {};
      cfg.telegram.enabled = true;
      cfg.telegram.bot_token = tgToken;

      console.log("\nFinding your chat ID...");
      console.log("  → Send any message to your bot in Telegram first, then press Enter.");
      await ask("Press Enter after you've messaged your bot: ");

      try {
        const https = require('https');
        const chatIds = await new Promise((resolve, reject) => {
          https.get(`https://api.telegram.org/bot${tgToken}/getUpdates`, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
              try {
                const data = JSON.parse(body);
                const ids = new Set();
                if (data.result) {
                  for (const u of data.result) {
                    if (u.message && u.message.chat) ids.add(u.message.chat.id);
                  }
                }
                resolve([...ids]);
              } catch { resolve([]); }
            });
          }).on('error', () => resolve([]));
        });

        if (chatIds.length > 0) {
          cfg.telegram.allowed_chat_ids = chatIds;
          console.log(`  ✅ Found chat ID(s): ${chatIds.join(', ')}`);
        } else {
          console.log("  ⚠️  No messages found. Make sure you messaged the bot.");
          console.log("     You can set allowed_chat_ids manually in daemon.yaml later.");
        }
      } catch {
        console.log("  ⚠️  Could not fetch chat ID. Set it manually in daemon.yaml.");
      }
      console.log("  ✅ Telegram configured!\n");
    } else {
      console.log("  Skipped.\n");
    }

    // --- Feishu Setup ---
    console.log("━━━ 📘 Feishu (Lark) Setup ━━━");
    console.log("");
    console.log("Step 1: Create an App");
    console.log("  • Go to: https://open.feishu.cn/app");
    console.log("  • Click '创建企业自建应用' (Create Enterprise App)");
    console.log("  • Fill in app name and description");
    console.log("");
    console.log("Step 2: Get Credentials");
    console.log("  • In left sidebar → '凭证与基础信息' (Credentials)");
    console.log("  • Copy App ID and App Secret");
    console.log("");
    console.log("Step 3: Enable Bot");
    console.log("  • In left sidebar → '应用能力' → '机器人' (Bot)");
    console.log("  • Enable the bot capability");
    console.log("");
    console.log("Step 4: Configure Events");
    console.log("  • In left sidebar → '事件订阅' (Event Subscription)");
    console.log("  • Choose '使用长连接接收事件' (Long Connection mode) — important!");
    console.log("  • Add event: im.message.receive_v1 (接收消息)");
    console.log("");
    console.log("Step 5: Add Permissions");
    console.log("  • In left sidebar → '权限管理' (Permissions)");
    console.log("  • Search and enable these 5 permissions:");
    console.log("    → im:message                       (获取与发送单聊、群组消息)");
    console.log("    → im:message.p2p_msg:readonly      (读取用户发给机器人的单聊消息)");
    console.log("    → im:message.group_at_msg:readonly (接收群聊中@机器人消息事件)");
    console.log("    → im:message:send_as_bot           (以应用的身份发消息)");
    console.log("    → im:resource                      (文件上传下载 - for file transfer)");
    console.log("");
    console.log("Step 6: Publish");
    console.log("  • In left sidebar → '版本管理与发布' (Version Management)");
    console.log("  • Click '创建版本' → fill version (e.g., 1.0.0)");
    console.log("  • Click '申请发布' (Apply for Release)");
    console.log("");

    const feishuAppId = (await ask("Paste your Feishu App ID (Enter to skip): ")).trim();
    if (feishuAppId) {
      const feishuSecret = (await ask("Paste your Feishu App Secret: ")).trim();
      if (feishuSecret) {
        if (!cfg.feishu) cfg.feishu = {};
        cfg.feishu.enabled = true;
        cfg.feishu.app_id = feishuAppId;
        cfg.feishu.app_secret = feishuSecret;
        if (!cfg.feishu.allowed_chat_ids) cfg.feishu.allowed_chat_ids = [];
        console.log("  ✅ Feishu configured!");
        console.log("  Note: allowed_chat_ids is empty = allow all users.");
        console.log("        To restrict, add chat IDs to daemon.yaml later.\n");
      }
    } else {
      console.log("  Skipped.\n");
    }

    // Write config
    fs.writeFileSync(DAEMON_CONFIG, yaml.dump(cfg, { lineWidth: -1 }), 'utf8');
    console.log("━━━ ✅ Setup Complete ━━━");
    console.log(`Config saved: ${DAEMON_CONFIG}`);
    console.log("\nNext steps:");
    console.log("  metame start                — start the daemon");
    console.log("  metame status               — check status");
    if (process.platform === 'darwin') {
      console.log("  metame daemon install-launchd — auto-start on login");
    }

    rl.close();
    process.exit(0);
    })();
    return; // Prevent further execution while async runs
  }

  if (subCmd === 'install-launchd') {
    if (process.platform !== 'darwin') {
      console.error("❌ launchd is macOS-only.");
      process.exit(1);
    }
    const plistDir = path.join(HOME_DIR, 'Library', 'LaunchAgents');
    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
    const plistPath = path.join(plistDir, 'com.metame.daemon.plist');
    const nodePath = process.execPath;
    // Capture current PATH so launchd can find `claude` and other tools
    const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.metame.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${DAEMON_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>METAME_ROOT</key>
    <string>${__dirname}</string>
    <key>PATH</key>
    <string>${currentPath}</string>
    <key>HOME</key>
    <string>${HOME_DIR}</string>
  </dict>
</dict>
</plist>`;
    fs.writeFileSync(plistPath, plistContent, 'utf8');
    console.log(`✅ launchd plist installed: ${plistPath}`);
    console.log("   Load now: launchctl load " + plistPath);
    console.log("   Unload:   launchctl unload " + plistPath);
    process.exit(0);
  }

  if (subCmd === 'start') {
    // Kill any lingering daemon.js processes to avoid Feishu WebSocket conflicts
    try {
      const { execSync: es } = require('child_process');
      const pids = es("pgrep -f 'node.*daemon\\.js' 2>/dev/null || true", { encoding: 'utf8' }).trim();
      if (pids) {
        for (const p of pids.split('\n').filter(Boolean)) {
          const n = parseInt(p, 10);
          if (n && n !== process.pid) try { process.kill(n, 'SIGKILL'); } catch { /* */ }
        }
        es('sleep 1');
      }
    } catch { /* ignore */ }
    // Check if already running
    if (fs.existsSync(DAEMON_PID)) {
      try { fs.unlinkSync(DAEMON_PID); } catch { /* */ }
    }
    if (!fs.existsSync(DAEMON_CONFIG)) {
      console.error("❌ No config found. Run: metame daemon init");
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error("❌ daemon.js not found. Reinstall MetaMe.");
      process.exit(1);
    }
    const bg = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname },
    });
    bg.unref();
    console.log(`✅ MetaMe daemon started (PID: ${bg.pid})`);
    console.log("   Logs: metame logs");
    console.log("   Stop: metame stop");
    process.exit(0);
  }

  if (subCmd === 'stop') {
    if (!fs.existsSync(DAEMON_PID)) {
      console.log("ℹ️  No daemon running (no PID file).");
      process.exit(0);
    }
    const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      // Wait for process to die (up to 3s), then force kill
      let dead = false;
      for (let i = 0; i < 6; i++) {
        const { execSync: es } = require('child_process');
        es('sleep 0.5');
        try { process.kill(pid, 0); } catch { dead = true; break; }
      }
      if (!dead) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      console.log(`✅ Daemon stopped (PID: ${pid})`);
    } catch (e) {
      console.log(`⚠️  Process ${pid} not found (may have already exited).`);
    }
    try { fs.unlinkSync(DAEMON_PID); } catch { /* ignore */ }
    process.exit(0);
  }

  if (subCmd === 'status') {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(DAEMON_STATE, 'utf8')); } catch { /* empty */ }

    // Check if running
    let isRunning = false;
    if (fs.existsSync(DAEMON_PID)) {
      const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
      try { process.kill(pid, 0); isRunning = true; } catch { /* dead */ }
    }

    console.log(`🤖 MetaMe Daemon: ${isRunning ? '🟢 Running' : '🔴 Stopped'}`);
    if (state.started_at) console.log(`   Started: ${state.started_at}`);
    if (state.pid) console.log(`   PID: ${state.pid}`);

    // Budget
    const budget = state.budget || {};
    const config = {};
    try { Object.assign(config, yaml.load(fs.readFileSync(DAEMON_CONFIG, 'utf8'))); } catch { /* empty */ }
    const limit = (config.budget && config.budget.daily_limit) || 50000;
    console.log(`   Budget: ${budget.tokens_used || 0}/${limit} tokens (${budget.date || 'no data'})`);

    // Tasks
    const tasks = state.tasks || {};
    if (Object.keys(tasks).length > 0) {
      console.log("   Recent tasks:");
      for (const [name, info] of Object.entries(tasks)) {
        const icon = info.status === 'success' ? '✅' : '❌';
        console.log(`     ${icon} ${name}: ${info.last_run || 'unknown'}`);
        if (info.output_preview) console.log(`        ${info.output_preview.slice(0, 80)}...`);
      }
    }
    process.exit(0);
  }

  if (subCmd === 'logs') {
    if (!fs.existsSync(DAEMON_LOG)) {
      console.log("ℹ️  No log file yet. Start the daemon first.");
      process.exit(0);
    }
    const content = fs.readFileSync(DAEMON_LOG, 'utf8');
    const lines = content.split('\n');
    const tail = lines.slice(-50).join('\n');
    console.log(tail);
    process.exit(0);
  }

  if (subCmd === 'run') {
    const taskName = process.argv[daemonIndex + 2];
    if (!taskName) {
      console.error("❌ Usage: metame daemon run <task-name>");
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error("❌ daemon.js not found. Reinstall MetaMe.");
      process.exit(1);
    }
    // Run in foreground using daemon.js --run
    const result = require('child_process').spawnSync(
      process.execPath,
      [DAEMON_SCRIPT, '--run', taskName],
      { stdio: 'inherit', env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname } }
    );
    process.exit(result.status || 0);
  }

  // Unknown subcommand
  console.log("📖 MetaMe Daemon Commands:");
  console.log("   metame start                  — start background daemon");
  console.log("   metame stop                   — stop daemon");
  console.log("   metame status                 — show status & budget");
  console.log("   metame logs                   — tail log file");
  console.log("   metame daemon init            — initialize config");
  console.log("   metame daemon run <name>      — run a task once");
  if (process.platform === 'darwin') {
    console.log("   metame daemon install-launchd — auto-start on macOS");
  }
  process.exit(0);
}

// ---------------------------------------------------------
// 5.75 WIZARD COMPLETE — mark onboarding wizard as done
// ---------------------------------------------------------
const isWizardComplete = process.argv.includes('wizard') && process.argv.includes('complete');
if (isWizardComplete) {
  clearOnboardingState();
  console.log("✅ 设置向导已完成！下次运行 metame 将直接进入正常模式。");
  console.log("   如需重新进入向导，运行: metame");
  process.exit(0);
}

// ---------------------------------------------------------
// 5.8 CONTINUE/SYNC — resume latest session from terminal
// ---------------------------------------------------------
// Usage: exit Claude first, then run `metame continue` from terminal.
// Finds the most recent session and launches Claude with --resume.
const isSync = process.argv.includes('sync') || process.argv.includes('continue');
if (isSync) {
  const projectsRoot = path.join(HOME_DIR, '.claude', 'projects');
  let bestSession = null;
  try {
    const cwd = process.cwd();
    const projDir = path.join(projectsRoot, cwd.replace(/\//g, '-'));
    const findLatest = (dir) => {
      try {
        return fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ id: f.replace('.jsonl', ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0] || null;
      } catch { return null; }
    };
    bestSession = findLatest(projDir);
    if (!bestSession) {
      for (const d of fs.readdirSync(projectsRoot)) {
        const s = findLatest(path.join(projectsRoot, d));
        if (s && (!bestSession || s.mtime > bestSession.mtime)) bestSession = s;
      }
    }
  } catch {}

  if (!bestSession) {
    console.error('No session found.');
    process.exit(1);
  }

  console.log(`\n🔄 Resuming session ${bestSession.id.slice(0, 8)}...\n`);
  const providerEnv = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).buildActiveEnv(); } catch { return {}; } })();
  const syncChild = spawn('claude', ['--resume', bestSession.id], {
    stdio: 'inherit',
    env: { ...process.env, ...providerEnv, METAME_ACTIVE_SESSION: 'true' }
  });
  syncChild.on('error', () => {
    console.error("Could not launch 'claude'. Is Claude Code installed?");
  });
  syncChild.on('close', (c) => process.exit(c || 0));
  return;
}

// ---------------------------------------------------------
// 6. SAFETY GUARD: RECURSION PREVENTION (v2)
// ---------------------------------------------------------
// We rely on our own scoped variable to detect nesting,
// ignoring the leaky CLAUDE_CODE_SSE_PORT from IDEs.
if (process.env.METAME_ACTIVE_SESSION === 'true') {
  console.error("\n🚫 ACTION BLOCKED: Nested Session Detected");
  console.error("   You are actively running inside a MetaMe session.");
  console.error("   To reload configuration, use: \x1b[36m!metame refresh\x1b[0m\n");
  process.exit(1);
}

// ---------------------------------------------------------
// 7. LAUNCH CLAUDE
// ---------------------------------------------------------
// Load provider env (zero-overhead for official Anthropic — returns {})
const activeProviderEnv = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).buildActiveEnv(); } catch { return {}; } })();
const activeProviderName = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).getActiveName(); } catch { return 'anthropic'; } })();
if (activeProviderName !== 'anthropic') {
  console.log(`🔌 Provider: ${activeProviderName}`);
}

// Spawn the official claude tool with our marker + provider env
const child = spawn('claude', process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ...activeProviderEnv, METAME_ACTIVE_SESSION: 'true' }
});

child.on('error', () => {
  console.error("\n❌ Error: Could not launch 'claude'.");
  console.error("   Please make sure Claude Code is installed globally:");
  console.error("   npm install -g @anthropic-ai/claude-code");
});

child.on('close', (code) => process.exit(code || 0));

// Launch background distillation AFTER Claude starts — no blocking
spawnDistillBackground();
const fs = require('fs');
const path = require('path');

let code = fs.readFileSync(path.join(__dirname, 'scripts', 'daemon.js'), 'utf8');

// Disable main execution safely
code = code.replace(/main\(\)\.catch\([\s\S]*?\}\);/, '// main() disabled for test');

// Mock spawnClaudeAsync
const mockCode = `
function spawnClaudeAsync(args, input, cwd, timeoutMs) {
  console.log('[MOCK CLAUDE] Called with prompt:\\n' + input.slice(0, 100) + '...');
  return Promise.resolve({
    output: "\`\`\`markdown\\n## Agent 角色\\n\\n我是由MOCK生成的测试Agent。\\n\`\`\`\\n",
    error: null
  });
}
`;

// Replace the declaration of spawnClaudeAsync
code = code.replace(/function spawnClaudeAsync\([\s\S]*?return new Promise\(\(resolve\) => \{[\s\S]*?\}\);\n\}/, mockCode);

code += `\nmodule.exports.handleCommand = handleCommand;
module.exports.pendingAgentFlows = pendingAgentFlows;
module.exports.loadConfig = loadConfig;`;

fs.writeFileSync(path.join(__dirname, 'scripts', 'test_daemon.js'), code, 'utf8');

const { handleCommand, pendingAgentFlows, loadConfig } = require('./scripts/test_daemon');

const bot = {
    sendMessage: async (chatId, text) => {
        console.log('\\x1b[32m[BOT -> USER ' + chatId + ']\\x1b[0m\\n' + text + '\\n');
    },
    sendButtons: async (chatId, text, buttons) => {
        console.log('\\x1b[32m[BOT -> USER ' + chatId + '] (Buttons)\\x1b[0m\\n' + text + '\\nButtons: ' + JSON.stringify(buttons) + '\\n');
    },
    sendCard: async (chatId, card) => {
        console.log('\\x1b[32m[BOT -> USER ' + chatId + '] (Card)\\x1b[0m\\n' + JSON.stringify(card, null, 2) + '\\n');
    },
    sendTyping: async (chatId) => {
        console.log('\\x1b[32m[BOT -> USER ' + chatId + '] (Typing...)\\x1b[0m\\n');
    }
};

const executeTask = () => ({ success: true, output: 'mock script output' });

async function runTest() {
    const chatId = 999111;
    const config = loadConfig();

    const testDir = path.join(require('os').homedir(), '.metame', 'test_agent');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    const claudeMdPath = path.join(testDir, 'CLAUDE.md');
    if (fs.existsSync(claudeMdPath)) fs.unlinkSync(claudeMdPath); // reset to clean state for test

    console.log('\\n\\n=== TEST 1: /agent new (Start flow) ===');
    await handleCommand(bot, chatId, '/agent new', config, executeTask);
    console.log('pendingAgentFlows:', pendingAgentFlows.get(String(chatId)));

    console.log('\\n\\n=== TEST 2: Select Directory ===');
    await handleCommand(bot, chatId, '/agent-dir ' + testDir, config, executeTask);
    console.log('pendingAgentFlows:', pendingAgentFlows.get(String(chatId)));

    console.log('\\n\\n=== TEST 3: Enter Name ===');
    await handleCommand(bot, chatId, 'TestAgent', config, executeTask);
    console.log('pendingAgentFlows:', pendingAgentFlows.get(String(chatId)));

    console.log('\\n\\n=== TEST 4: Enter Description (Finish flow) ===');
    await handleCommand(bot, chatId, 'I want this agent to test the bot framework.', config, executeTask);
    console.log('pendingAgentFlows:', pendingAgentFlows.get(String(chatId)));

    console.log('\\n[VERIFY] Check test agent CLAUDE.md:');
    if (fs.existsSync(claudeMdPath)) {
        console.log(fs.readFileSync(claudeMdPath, 'utf8'));
    } else {
        console.log('CLAUDE.md not found!');
    }

    console.log('\\n\\n=== TEST 5: /agent list ===');
    await handleCommand(bot, chatId, '/agent list', config, executeTask);

    console.log('\\n\\n=== TEST 6: /agent edit ===');
    await handleCommand(bot, chatId, '/agent edit', config, executeTask);
    console.log('pendingAgentFlows for edit:', pendingAgentFlows.get(String(chatId) + ':edit'));

    console.log('\\n\\n=== TEST 7: Edit Description (Finish edit) ===');
    await handleCommand(bot, chatId, 'Please update identity to master bot.', config, executeTask);
    console.log('\\n[VERIFY AFTER EDIT] CLAUDE.md:');
    if (fs.existsSync(claudeMdPath)) {
        console.log(fs.readFileSync(claudeMdPath, 'utf8'));
    }

    console.log('\\n\\n=== TEST 8: /agent reset ===');
    await handleCommand(bot, chatId, '/agent reset', config, executeTask);
    console.log('\\n[VERIFY AFTER RESET] CLAUDE.md:');
    if (fs.existsSync(claudeMdPath)) {
        console.log(fs.readFileSync(claudeMdPath, 'utf8'));
    }
}

runTest().catch(console.error);

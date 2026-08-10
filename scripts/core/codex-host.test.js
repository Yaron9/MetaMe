'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  listEnabledPlugins,
  findClaudeOnlyPluginHooks,
  disablePluginSections,
  buildMetaMeCodexHooks,
  mergeMetaMeCodexHooks,
} = require('./codex-host');

describe('codex host compatibility', () => {
  it('finds enabled plugins with Claude-only invalid hook metadata', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-codex-host-'));
    const hooksDir = path.join(codexHome, 'plugins', 'cache', 'claude-market', 'ralph', '1.0.0', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      description: 'Claude hook',
      hooks: { Stop: [{ hooks: [{ command: '${CLAUDE_PLUGIN_ROOT}/stop.sh' }] }] },
    }));
    const configText = '[plugins."ralph@claude-market"]\nenabled = true\n';

    assert.deepEqual(listEnabledPlugins(configText), ['ralph@claude-market']);
    assert.deepEqual(findClaudeOnlyPluginHooks({ fs, path, codexHome, configText }).map((x) => x.pluginId), [
      'ralph@claude-market',
    ]);
  });

  it('does not quarantine valid Codex hooks or disabled plugins', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-codex-host-'));
    const hooksDir = path.join(codexHome, 'plugins', 'cache', 'market', 'native', '1', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({ hooks: {} }));
    const configText = [
      '[plugins."native@market"]',
      'enabled = true',
      '[plugins."off@market"]',
      'enabled = false',
    ].join('\n');
    assert.deepEqual(findClaudeOnlyPluginHooks({ fs, path, codexHome, configText }), []);
  });

  it('disables only selected plugin sections and preserves surrounding TOML', () => {
    const input = [
      'model = "gpt"',
      '[plugins."bad@market"]',
      'enabled = true # imported',
      '[plugins."good@market"]',
      'enabled = true',
      '',
    ].join('\n');
    const output = disablePluginSections(input, ['bad@market']);
    assert.match(output, /\[plugins\."bad@market"\]\nenabled = false # imported/);
    assert.match(output, /\[plugins\."good@market"\]\nenabled = true/);
  });

  it('merges MetaMe hooks idempotently without deleting user hooks', () => {
    const managed = buildMetaMeCodexHooks({
      signalCaptureScript: '/home/.metame/signal-capture.js',
      memoryRecallScript: '/home/.metame/hooks/memory-recall-context.js',
      stopCaptureScript: '/home/.metame/hooks/stop-session-capture.js',
    });
    const existing = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'node /user/custom.js' }] },
          { hooks: [{ type: 'command', command: 'node /old/stop-session-capture.js' }] },
        ],
      },
    };
    const once = mergeMetaMeCodexHooks(existing, managed);
    const twice = mergeMetaMeCodexHooks(once, managed);
    assert.deepEqual(twice, once);
    assert.equal(once.hooks.UserPromptSubmit[0].hooks.length, 2);
    assert.equal(once.hooks.Stop.length, 2);
    assert.match(once.hooks.Stop[0].hooks[0].command, /custom\.js/);
    assert.match(once.hooks.Stop[1].hooks[0].command, /\.metame\/hooks\/stop-session-capture\.js/);
  });

  it('retires the legacy automatic memory recall hook when disabled', () => {
    const managed = buildMetaMeCodexHooks({
      signalCaptureScript: '/home/.metame/signal-capture.js',
      memoryRecallScript: null,
      stopCaptureScript: '/home/.metame/hooks/stop-session-capture.js',
    });
    const existing = {
      hooks: {
        UserPromptSubmit: [{
          hooks: [
            { type: 'command', command: 'node /home/.metame/signal-capture.js' },
            { type: 'command', command: 'node /home/.metame/hooks/memory-recall-context.js' },
          ],
        }],
      },
    };
    const merged = mergeMetaMeCodexHooks(existing, managed);
    const commands = merged.hooks.UserPromptSubmit.flatMap(group => group.hooks.map(hook => hook.command));
    assert.equal(commands.some(command => command.includes('memory-recall-context.js')), false);
    assert.equal(commands.some(command => command.includes('signal-capture.js')), true);
  });
});

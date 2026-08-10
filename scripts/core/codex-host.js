'use strict';

const PLUGIN_SECTION_RE = /^\[plugins\."([^"]+)"\]\s*$/;

function listEnabledPlugins(configText) {
  const enabled = [];
  let current = null;
  for (const line of String(configText || '').split('\n')) {
    const section = line.match(PLUGIN_SECTION_RE);
    if (section) {
      current = section[1];
      continue;
    }
    if (/^\[/.test(line)) current = null;
    if (current && /^\s*enabled\s*=\s*true\s*(?:#.*)?$/.test(line)) enabled.push(current);
  }
  return enabled;
}

function findClaudeOnlyPluginHooks({ fs, path, codexHome, configText }) {
  const issues = [];
  for (const pluginId of listEnabledPlugins(configText)) {
    const separator = pluginId.lastIndexOf('@');
    if (separator <= 0) continue;
    const pluginName = pluginId.slice(0, separator);
    const marketplace = pluginId.slice(separator + 1);
    const cacheRoot = path.join(codexHome, 'plugins', 'cache', marketplace, pluginName);
    let versions = [];
    try { versions = fs.readdirSync(cacheRoot); } catch { continue; }

    for (const version of versions) {
      const hooksPath = path.join(cacheRoot, version, 'hooks', 'hooks.json');
      let raw;
      let parsed;
      try {
        raw = fs.readFileSync(hooksPath, 'utf8');
        parsed = JSON.parse(raw);
      } catch { continue; }
      const extraFields = Object.keys(parsed).filter((key) => key !== 'hooks');
      if (extraFields.length === 0 || !raw.includes('CLAUDE_PLUGIN_ROOT')) continue;
      issues.push({ pluginId, hooksPath, extraFields });
      break;
    }
  }
  return issues;
}

function disablePluginSections(configText, pluginIds) {
  const disabled = new Set(pluginIds || []);
  if (disabled.size === 0) return String(configText || '');
  let current = null;
  return String(configText || '').split('\n').map((line) => {
    const section = line.match(PLUGIN_SECTION_RE);
    if (section) {
      current = section[1];
      return line;
    }
    if (/^\[/.test(line)) current = null;
    if (current && disabled.has(current) && /^(\s*enabled\s*=\s*)true(\s*(?:#.*)?)$/.test(line)) {
      return line.replace(/^(\s*enabled\s*=\s*)true/, '$1false');
    }
    return line;
  }).join('\n');
}

function buildMetaMeCodexHooks({ signalCaptureScript, memoryRecallScript, stopCaptureScript }) {
  const promptHooks = [{ type: 'command', command: `node "${signalCaptureScript}"` }];
  if (memoryRecallScript) {
    promptHooks.push({ type: 'command', command: `node "${memoryRecallScript}"` });
  }
  return {
    UserPromptSubmit: [{
      hooks: promptHooks,
    }],
    Stop: [{
      hooks: [{ type: 'command', command: `node "${stopCaptureScript}"` }],
    }],
  };
}

function mergeMetaMeCodexHooks(existing, managedHooks) {
  const result = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? JSON.parse(JSON.stringify(existing))
    : {};
  if (!result.hooks || typeof result.hooks !== 'object' || Array.isArray(result.hooks)) result.hooks = {};

  for (const [event, groups] of Object.entries(managedHooks)) {
    const current = Array.isArray(result.hooks[event]) ? result.hooks[event] : [];
    const managedScriptNames = groups.flatMap((group) => group.hooks || [])
      .map((hook) => String(hook.command || '').match(/([\w-]+\.js)/)?.[1])
      .filter(Boolean);
    const retiredScriptNames = event === 'UserPromptSubmit' && !managedScriptNames.includes('memory-recall-context.js')
      ? ['memory-recall-context.js']
      : [];
    const managedOrRetiredNames = [...managedScriptNames, ...retiredScriptNames];
    const retained = current.filter((group) => !(group.hooks || []).some((hook) =>
      managedOrRetiredNames.some((name) => String(hook.command || '').includes(name))));
    result.hooks[event] = [...retained, ...groups];
  }
  return result;
}

module.exports = {
  listEnabledPlugins,
  findClaudeOnlyPluginHooks,
  disablePluginSections,
  buildMetaMeCodexHooks,
  mergeMetaMeCodexHooks,
};

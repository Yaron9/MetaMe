'use strict';

const path = require('node:path');

const REQUIRED_TOOLS = Object.freeze([
  'agent_context', 'memory_feedback', 'memory_get', 'memory_search',
  'profile_get', 'skill_get', 'skill_list',
]);

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function expandHome(value, home) {
  const text = String(value || '').trim();
  if (text === '~') return home;
  return text.startsWith('~/') ? path.join(home, text.slice(2)) : text;
}

function claudeRegistration({ fs, home, cwd }) {
  const files = [
    path.join(cwd, '.mcp.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'mcp.json'),
  ];
  for (const file of files) {
    const doc = readJson(fs, file);
    const entry = doc?.mcpServers?.metame;
    if (!entry) continue;
    const args = Array.isArray(entry.args) ? entry.args : [];
    return { configured: true, configFile: file, serverPath: expandHome(args.find(v => /metame-mcp-server\.js$/.test(String(v))) || '', home) };
  }
  return { configured: false, configFile: files[0], serverPath: '' };
}

function codexRegistration({ fs, home }) {
  const configFile = path.join(home, '.codex', 'config.toml');
  let text = '';
  try { text = fs.readFileSync(configFile, 'utf8'); } catch { return { configured: false, configFile, serverPath: '' }; }
  const match = text.match(/(?:^|\n)\[mcp_servers\.metame\]\s*\n([\s\S]*?)(?=\n\[[^\]]+\]|$)/);
  if (!match) return { configured: false, configFile, serverPath: '' };
  const args = match[1].match(/^\s*args\s*=\s*\[([^\]]*)\]/m);
  const server = args && args[1].match(/["']([^"']*metame-mcp-server\.js)["']/);
  return { configured: true, configFile, serverPath: expandHome(server ? server[1] : '', home) };
}

function capabilityState({ detected, configured, reachable, verified }) {
  if (verified) return 'verified';
  if (reachable) return 'reachable';
  if (configured) return 'configured';
  return detected ? 'detected' : 'missing';
}

function inspectHost(name, {
  fs,
  home,
  cwd,
  probeServer = () => ({ reachable: false, tools: [] }),
} = {}) {
  if (!fs || !home || !cwd || !['claude', 'codex'].includes(name)) throw new Error('inspectHost requires a supported host and fs/home/cwd');
  const registration = name === 'claude'
    ? claudeRegistration({ fs, home, cwd })
    : codexRegistration({ fs, home });
  const hostDir = path.join(home, name === 'claude' ? '.claude' : '.codex');
  const detected = fs.existsSync(hostDir);
  const defaultServer = path.join(home, '.metame', 'metame-mcp-server.js');
  const serverPath = registration.serverPath || defaultServer;
  const probe = registration.configured && fs.existsSync(serverPath)
    ? probeServer(serverPath)
    : { reachable: false, tools: [] };
  const tools = [...new Set(Array.isArray(probe.tools) ? probe.tools : [])].sort();
  const missingTools = REQUIRED_TOOLS.filter(tool => !tools.includes(tool));
  const reachable = !!probe.reachable;
  const verified = reachable && missingTools.length === 0;
  const automaticContext = name === 'claude'
    ? fs.existsSync(path.join(home, '.claude', 'CLAUDE.md'))
    : fs.existsSync(path.join(home, '.codex', 'AGENTS.md')) || fs.existsSync(path.join(home, 'AGENTS.md'));
  const sessionVisibility = name === 'claude'
    ? fs.existsSync(path.join(home, '.claude', 'projects'))
    : fs.existsSync(path.join(home, '.codex', 'state_5.sqlite'));
  return {
    host: name,
    state: capabilityState({ detected, configured: registration.configured, reachable, verified }),
    detected,
    configured: registration.configured,
    reachable,
    verified,
    config_file: registration.configFile,
    server_path: serverPath,
    missing_tools: missingTools,
    capabilities: {
      mcp_access: verified ? 'verified' : reachable ? 'partial' : registration.configured ? 'configured' : 'missing',
      automatic_context: automaticContext ? 'detected' : 'missing',
      session_visibility: sessionVisibility ? 'detected' : 'missing',
      outcome_feedback: tools.includes('memory_feedback') ? 'verified' : 'missing',
    },
  };
}

function inspectHosts(options) {
  return ['claude', 'codex'].map(host => inspectHost(host, options));
}

module.exports = {
  REQUIRED_TOOLS,
  inspectHost,
  inspectHosts,
  _internal: { capabilityState, claudeRegistration, codexRegistration, expandHome },
};

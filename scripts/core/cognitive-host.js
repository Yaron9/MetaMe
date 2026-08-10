'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REQUIRED_TOOLS = Object.freeze([
  'agent_context', 'memory_feedback', 'memory_get', 'memory_search',
  'profile_get', 'skill_get', 'skill_list',
]);

const DEFAULT_HOST_NAMES = Object.freeze(['claude', 'codex']);
const HOST_NAMES = Object.freeze(['claude', 'codex', 'pi', 'agy', 'limited']);

// This is intentionally a declarative Cognitive Host matrix. Native runtime
// and Session Source adapters remain owned by their Engine Plugins; this
// module only describes what the read-only Host doctor may inspect.
const HOST_DEFINITIONS = Object.freeze({
  claude: Object.freeze({
    displayName: 'Claude Code', executable: 'claude', hostDir: '.claude',
    registration: 'claude', mcp: 'supported', sessionSource: 'supported',
    automaticContext: 'supported', outcomeFeedback: 'supported',
    automaticContextPaths: Object.freeze(['.claude/CLAUDE.md']),
    sessionPaths: Object.freeze(['.claude/projects']),
  }),
  codex: Object.freeze({
    displayName: 'Codex', executable: 'codex', hostDir: '.codex',
    registration: 'codex', mcp: 'supported', sessionSource: 'supported',
    automaticContext: 'supported', outcomeFeedback: 'supported',
    automaticContextPaths: Object.freeze(['.codex/AGENTS.md', 'AGENTS.md']),
    sessionPaths: Object.freeze(['.codex/state_5.sqlite']),
  }),
  pi: Object.freeze({
    displayName: 'Pi', executable: 'pi', hostDir: '.pi',
    registration: null, mcp: 'unsupported', sessionSource: 'unsupported',
    automaticContext: 'unsupported', outcomeFeedback: 'unsupported',
    automaticContextPaths: Object.freeze([]), sessionPaths: Object.freeze([]),
  }),
  agy: Object.freeze({
    displayName: 'agy', executable: 'agy', hostDir: '.gemini',
    registration: null, mcp: 'unsupported', sessionSource: 'unsupported',
    automaticContext: 'unsupported', outcomeFeedback: 'unsupported',
    automaticContextPaths: Object.freeze([]), sessionPaths: Object.freeze([]),
  }),
  limited: Object.freeze({
    displayName: 'Limited Host', executable: '', hostDir: '',
    registration: null, mcp: 'unsupported', sessionSource: 'unsupported',
    automaticContext: 'unsupported', outcomeFeedback: 'unsupported',
    automaticContextPaths: Object.freeze([]), sessionPaths: Object.freeze([]),
  }),
});

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function expandHome(value, home) {
  const text = String(value || '').trim();
  if (text === '~') return home;
  return text.startsWith('~/') ? path.join(home, text.slice(2)) : text;
}

function findServerArg(args, home) {
  const server = args.find(value => /metame-mcp-server(?:-sdk)?\.(?:js|mjs)$/.test(String(value)));
  return expandHome(server || '', home);
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
    return {
      configured: true,
      configFile: file,
      serverPath: findServerArg(args, home),
    };
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
  const values = args ? args[1].match(/["']([^"']+)["']/g) || [] : [];
  return {
    configured: true,
    configFile,
    serverPath: findServerArg(values.map(value => value.slice(1, -1)), home),
  };
}

function registrationFor(name, options) {
  const definition = HOST_DEFINITIONS[name];
  if (!definition || !definition.registration) {
    return { configured: false, configFile: null, serverPath: '' };
  }
  return definition.registration === 'claude'
    ? claudeRegistration(options)
    : codexRegistration(options);
}

function capabilityState({ detected, configured, reachable, verified }) {
  if (verified) return 'verified';
  if (reachable) return 'reachable';
  if (configured) return 'configured';
  return detected ? 'detected' : 'missing';
}

function resolveExecutable(binary, probeExecutable) {
  if (!binary) return '';
  if (typeof probeExecutable === 'function') {
    try { return String(probeExecutable(binary) || ''); } catch { return ''; }
  }
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    return String(execFileSync(lookup, [binary], { encoding: 'utf8', timeout: 3000 }) || '')
      .split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

function inspectRuntime(name, definition, { fs, home, probeExecutable }) {
  if (!definition.executable) return { state: 'unsupported', executable: '' };
  const executable = resolveExecutable(definition.executable, probeExecutable);
  const detected = !!executable || fs.existsSync(path.join(home, definition.hostDir));
  return { state: detected ? 'detected' : 'missing', executable };
}

function inspectFilesystemCapability(fs, home, relativePaths, support) {
  if (support === 'unsupported') return { state: 'unsupported', paths: [] };
  const paths = relativePaths.filter(relative => fs.existsSync(path.join(home, relative)));
  return { state: paths.length > 0 ? 'detected' : 'missing', paths };
}

function normalizeTools(value) {
  return [...new Set(Array.isArray(value) ? value.map(String).filter(Boolean) : [])].sort();
}

function unavailableProbe() {
  return { reachable: false, tools: [], protocol_version: null, server_info: null, error: null };
}

function inspectMcp(name, definition, options) {
  if (definition.mcp === 'unsupported') {
    return {
      state: 'unsupported', configured: false, reachable: false, verified: false,
      protocol_version: null, server_info: null, server_capabilities: {},
      client_verified: false, protocol_verified: false, missing_tools: [],
      error: null, config_file: null, server_path: '', tools: [],
    };
  }
  const registration = registrationFor(name, options);
  const defaultServer = path.join(options.home, '.metame', 'metame-mcp-server.js');
  const serverPath = registration.serverPath
    ? path.isAbsolute(registration.serverPath)
      ? registration.serverPath
      : path.resolve(path.dirname(registration.configFile || options.cwd), registration.serverPath)
    : defaultServer;
  let probe = unavailableProbe();
  if (registration.configured && !options.fs.existsSync(serverPath)) {
    probe.error = { code: 'MCP_SERVER_MISSING', message: 'registered MetaMe MCP server path does not exist' };
  } else if (registration.configured) {
    try {
      probe = options.probeServer(serverPath) || unavailableProbe();
    } catch (error) {
      probe = {
        ...unavailableProbe(),
        error: {
          code: error && error.code ? String(error.code) : 'MCP_PROBE_FAILED',
          message: error && error.message ? String(error.message).slice(0, 300) : 'MCP probe failed',
        },
      };
    }
  }
  const tools = normalizeTools(probe.tools);
  const reachable = !!probe.reachable;
  const missingTools = REQUIRED_TOOLS.filter(tool => !tools.includes(tool));
  const protocolVerified = probe.protocol_verified !== false && reachable;
  const clientVerified = probe.client_verified !== false && reachable;
  const verified = reachable && protocolVerified && clientVerified && missingTools.length === 0;
  return {
    state: capabilityState({ detected: registration.configured, configured: registration.configured, reachable, verified }),
    configured: registration.configured,
    reachable,
    verified,
    protocol_version: probe.protocol_version || null,
    server_info: probe.server_info || null,
    server_capabilities: probe.server_capabilities || {},
    client_verified: clientVerified,
    protocol_verified: protocolVerified,
    missing_tools: missingTools,
    error: probe.error || null,
    config_file: registration.configFile,
    server_path: serverPath,
    tools,
  };
}

function inspectHost(name, {
  fs,
  home,
  cwd,
  probeServer = () => unavailableProbe(),
  probeExecutable,
} = {}) {
  const host = String(name || '').trim().toLowerCase();
  const definition = HOST_DEFINITIONS[host];
  if (!fs || !home || !cwd || !definition) throw new Error('inspectHost requires a supported host and fs/home/cwd');
  const options = { fs, home, cwd, probeServer, probeExecutable };
  const runtime = inspectRuntime(host, definition, options);
  const sessionSource = inspectFilesystemCapability(fs, home, definition.sessionPaths, definition.sessionSource);
  const automaticContext = inspectFilesystemCapability(fs, home, definition.automaticContextPaths, definition.automaticContext);
  const mcp = inspectMcp(host, definition, options);
  const outcomeFeedback = definition.outcomeFeedback === 'unsupported'
    ? { state: 'unsupported', tool: 'memory_feedback' }
    : {
      state: mcp.state === 'verified' && mcp.tools.includes('memory_feedback') ? 'verified' : mcp.state,
      tool: 'memory_feedback',
    };
  const detected = runtime.state !== 'missing' && runtime.state !== 'unsupported';
  return {
    host,
    display_name: definition.displayName,
    state: capabilityState({ detected, configured: mcp.configured, reachable: mcp.reachable, verified: mcp.verified }),
    detected,
    configured: mcp.configured,
    reachable: mcp.reachable,
    verified: mcp.verified,
    config_file: mcp.config_file,
    server_path: mcp.server_path,
    missing_tools: mcp.missing_tools,
    mcp,
    details: {
      runtime,
      session_source: sessionSource,
      automatic_context: automaticContext,
      outcome_feedback: outcomeFeedback,
    },
    capabilities: {
      runtime: runtime.state,
      session_source: sessionSource.state,
      mcp: mcp.state,
      automatic_context: automaticContext.state,
      outcome_feedback: outcomeFeedback.state,
      // Compatibility aliases retained for existing doctor consumers.
      mcp_access: mcp.state === 'verified' ? 'verified' : mcp.reachable ? 'partial' : mcp.configured ? 'configured' : mcp.state,
      session_visibility: sessionSource.state === 'unsupported' ? 'missing' : sessionSource.state,
    },
  };
}

function inspectHosts(options = {}) {
  const names = Array.isArray(options.hosts) ? options.hosts : DEFAULT_HOST_NAMES;
  return names.map(name => inspectHost(name, options));
}

function inspectCapabilityMatrix(options = {}) {
  return inspectHosts({ ...options, hosts: HOST_NAMES });
}

function normalizePlanArgs(nameOrOptions, options = {}) {
  if (typeof nameOrOptions === 'string') return { name: nameOrOptions, options };
  const input = nameOrOptions && typeof nameOrOptions === 'object' ? nameOrOptions : {};
  return { name: input.host || input.name, options: { ...input, ...options } };
}

function planInstall(nameOrOptions, options = {}) {
  const normalized = normalizePlanArgs(nameOrOptions, options);
  const name = String(normalized.name || '').trim().toLowerCase();
  const definition = HOST_DEFINITIONS[name];
  const home = normalized.options.home || require('node:os').homedir();
  const cwd = normalized.options.cwd || process.cwd();
  const fs = normalized.options.fs || require('node:fs');
  if (!definition) throw new Error('planInstall requires a supported host');
  const registration = registrationFor(name, { fs, home, cwd });
  const serverPath = normalized.options.serverPath || path.join(home, '.metame', 'metame-mcp-server.js');
  const supported = definition.mcp !== 'unsupported';
  return {
    host: name,
    display_name: definition.displayName,
    operation: !supported
      ? 'unsupported'
      : registration.configured ? 'repair_mcp_registration' : 'install_mcp_registration',
    status: supported ? 'planned' : 'unsupported',
    supported,
    mode: 'plan-only',
    applied: false,
    reversible: true,
    requires_authorization: supported,
    config_file: registration.configFile,
    server_path: serverPath,
    changes: supported ? [{
      target: registration.configFile,
      entry: 'metame',
      action: registration.configured ? 'replace' : 'add',
      desired: { command: normalized.options.nodeBinary || process.execPath, args: [serverPath] },
      rollback: registration.configured ? 'restore the pre-plan metame entry' : 'remove only the planned metame entry',
    }] : [],
    reason: supported ? null : 'host_mcp_unsupported',
  };
}

function verifyHost(nameOrOptions, options = {}) {
  const normalized = normalizePlanArgs(nameOrOptions, options);
  const report = inspectHost(normalized.name, normalized.options);
  return { ok: report.verified, host: report.host, report };
}

module.exports = {
  DEFAULT_HOST_NAMES,
  HOST_NAMES,
  HOST_DEFINITIONS,
  REQUIRED_TOOLS,
  inspectHost,
  inspectHosts,
  inspectCapabilityMatrix,
  planInstall,
  planRepair: planInstall,
  verifyHost,
  detectHost: inspectHost,
  inspectCapabilities: inspectHost,
  _internal: {
    capabilityState,
    claudeRegistration,
    codexRegistration,
    expandHome,
    findServerArg,
    inspectFilesystemCapability,
    inspectMcp,
    inspectRuntime,
    normalizeTools,
    registrationFor,
  },
};

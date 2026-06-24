'use strict';

const PLUGIN_FILES = Object.freeze([
  'plugin.json',
  'mcp_config.json',
  'bin/playwright-mcp.js',
  'bin/akshare-stock-mcp.js',
  'bin/trendradar-mcp.js',
]);

function computePluginHash({ fs, path, crypto, pluginSource, installedRoot = '', nodeBinary = '' }) {
  const digest = crypto.createHash('sha256');
  for (const rel of PLUGIN_FILES) digest.update(fs.readFileSync(path.join(pluginSource, rel)));
  digest.update(`\0${installedRoot}\0${nodeBinary}`);
  return digest.digest('hex');
}

function buildInstalledMcpConfig(installedRoot, nodeBinary, options = {}) {
  const mcpServers = {
      playwright: {
        command: nodeBinary,
        args: [`${installedRoot}/bin/playwright-mcp.js`],
      },
      'akshare-stock': {
        command: nodeBinary,
        args: [`${installedRoot}/bin/akshare-stock-mcp.js`],
      },
  };
  if (options.trendRadarAvailable) {
    mcpServers.trendradar = {
      command: nodeBinary,
      args: [`${installedRoot}/bin/trendradar-mcp.js`],
    };
  }
  return {
    mcpServers,
  };
}

function installedConfigMatches(fs, configFile, expected) {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(configFile, 'utf8'))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function backupPath(fs, path, source, backupRoot, key) {
  if (!fs.existsSync(source)) return null;
  const target = path.join(backupRoot, key);
  fs.cpSync(source, target, { recursive: true });
  return { source, target };
}

function restoreBackups(fs, backups) {
  for (const item of backups) {
    fs.rmSync(item.source, { recursive: true, force: true });
    fs.cpSync(item.target, item.source, { recursive: true });
  }
}

function ensureAgyPlugin(deps) {
  const { fs, path, crypto, execFileSync, pluginSource, home, metameDir, nodeBinary } = deps;
  if (deps.platform !== 'darwin' || !fs.existsSync(pluginSource)) return { updated: false, reason: 'unsupported' };
  const agyBin = execFileSync('/usr/bin/which', ['agy'], { encoding: 'utf8', timeout: 3000 }).trim();
  const marker = path.join(metameDir, 'agy-plugin.sha256');
  const currentHash = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
  const installedRoot = path.join(home, '.gemini', 'config', 'plugins', 'metame-tools');
  const trendRadarPython = path.join(home, 'AGI', 'TrendRadar', '.venv', 'bin', 'python');
  const installedConfig = buildInstalledMcpConfig(installedRoot, nodeBinary, {
    trendRadarAvailable: fs.existsSync(trendRadarPython),
  });
  const configFile = path.join(installedRoot, 'mcp_config.json');
  const expectedHash = computePluginHash({ fs, path, crypto, pluginSource, installedRoot, nodeBinary });
  if (currentHash === expectedHash && fs.existsSync(installedRoot) && installedConfigMatches(fs, configFile, installedConfig)) {
    return { updated: false, reason: 'current' };
  }

  const backupRoot = fs.mkdtempSync(path.join(metameDir, 'agy-plugin-backup-'));
  const configRoot = path.join(home, '.gemini', 'config');
  const backups = [
    backupPath(fs, path, installedRoot, backupRoot, 'plugin'),
    backupPath(fs, path, path.join(configRoot, 'import_manifest.json'), backupRoot, 'import_manifest.json'),
    backupPath(fs, path, path.join(configRoot, 'mcp_config.json'), backupRoot, 'mcp_config.json'),
  ].filter(Boolean);
  try {
    try { execFileSync(agyBin, ['plugin', 'uninstall', 'metame-tools'], { stdio: 'ignore', timeout: 10000 }); } catch { /* absent */ }
    execFileSync(agyBin, ['plugin', 'install', pluginSource], { stdio: 'pipe', timeout: 30000 });
    const configTemp = `${configFile}.tmp-${process.pid}`;
    fs.writeFileSync(configTemp, `${JSON.stringify(installedConfig, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(configTemp, configFile);
    if (!installedConfigMatches(fs, configFile, installedConfig)) throw new Error('agy_plugin_config_validation_failed');
    fs.writeFileSync(marker, `${expectedHash}\n`, { mode: 0o600 });
    return { updated: true, reason: 'installed', installedRoot };
  } catch (err) {
    restoreBackups(fs, backups);
    throw err;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

module.exports = {
  PLUGIN_FILES,
  computePluginHash,
  buildInstalledMcpConfig,
  installedConfigMatches,
  ensureAgyPlugin,
};

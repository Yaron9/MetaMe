'use strict';

const fs = require('fs');
const path = require('path');

const {
  collectDeployGroups,
  isDeployableManagedFile,
  isTestScriptFile,
} = require('./deploy-manifest');
const { fingerprintDirectory } = require('./skill-registry-sync');

// Files whose extension we consider "managed" by the sync flow. Stale-dest
// cleanup only ever deletes files matching this pattern, so unrelated dest
// artifacts (README, package.json, etc.) are never touched.
const MANAGED_EXT_RE = /\.(js|mjs|yaml|sh)$/;

function syncDirFiles(srcDir, destDir, { fileList, chmod, cleanupStale, cleanupExclusions } = {}) {
  if (!fs.existsSync(srcDir)) return false;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let updated = false;
  const files = fileList || fs.readdirSync(srcDir).filter((f) => {
    if (!fs.statSync(path.join(srcDir, f)).isFile()) return false;
    return isDeployableManagedFile(f);
  });
  for (const file of files) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    if (!fs.existsSync(src)) continue;
    const srcContent = fs.readFileSync(src, 'utf8');
    const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
    if (srcContent !== destContent) {
      fs.writeFileSync(dest, srcContent, 'utf8');
      if (chmod) {
        try { fs.chmodSync(dest, chmod); } catch { /* ignore */ }
      }
      updated = true;
    }
  }

  // Stale-dest cleanup: a previous sync may have copied files whose source
  // has since been deleted (e.g. a zombie module removed in a refactor). Walk
  // the dest dir and delete any managed file that isn't in the desired src
  // set, skipping caller-supplied exclusions (e.g. daemon.yaml which is
  // intentionally not synced).
  if (cleanupStale) {
    const srcSet = new Set(files);
    const exclude = cleanupExclusions || new Set();
    for (const entry of fs.readdirSync(destDir)) {
      const full = path.join(destDir, entry);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch { continue; }
      if (srcSet.has(entry)) continue;
      if (exclude.has(entry)) continue;
      if (!MANAGED_EXT_RE.test(entry)) continue;
      if (isTestScriptFile(entry)) {
        try {
          fs.unlinkSync(full);
          updated = true;
        } catch { /* ignore — best-effort cleanup */ }
        continue;
      }
      try {
        fs.unlinkSync(full);
        updated = true;
      } catch { /* ignore — best-effort cleanup */ }
    }
  }

  return updated;
}

const PLUGIN_EXCLUDED_SCRIPTS = new Set([
  'sync-readme.js',
  'test_daemon.js',
  'build-mcp-bundle.js',
  'metame-mcp-stdio-probe-bundle-entry.mjs',
  'daemon.yaml',
]);
const MCP_BUNDLE_NOTICE = 'metame-mcp-server-sdk.bundle.NOTICES.txt';

function rebuildMcpBundle(projectRoot) {
  const entrypoint = path.join(projectRoot, 'scripts', 'metame-mcp-server-sdk.mjs');
  const buildScript = path.join(projectRoot, 'scripts', 'build-mcp-bundle.js');
  if (!fs.existsSync(entrypoint) || !fs.existsSync(buildScript)) return false;

  try {
    require.resolve('esbuild', { paths: [path.dirname(buildScript)] });
  } catch {
    throw new Error('MCP SDK bundle sync requires the esbuild dev dependency; run npm install first');
  }

  require(buildScript).buildMcpBundle();
  return true;
}

function writeJsonIfChanged(filePath, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  if (prev === next) return false;
  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

function syncPluginManifest(projectRoot = process.cwd()) {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const manifestPath = path.join(projectRoot, 'plugin', '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(packageJsonPath) || !fs.existsSync(manifestPath)) return false;

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const next = {
    ...manifest,
    version: pkg.version,
    description: pkg.description || manifest.description,
  };
  return writeJsonIfChanged(manifestPath, next);
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function syncProjectSkillEntrypoints(projectRoot = process.cwd()) {
  const sourceRoot = path.join(projectRoot, '.claude', 'skills');
  const destinationRoot = path.join(projectRoot, '.agents', 'skills');
  const projectSkills = ['metame-release'];
  let updated = false;

  for (const skillName of projectSkills) {
    const source = path.join(sourceRoot, skillName);
    const destination = path.join(destinationRoot, skillName);
    if (!pathExists(source)) continue;
    const destinationIsCurrent = pathExists(destination)
      && !fs.lstatSync(destination).isSymbolicLink()
      && fingerprintDirectory(source) === fingerprintDirectory(destination);
    if (destinationIsCurrent) continue;
    if (pathExists(destination)) fs.rmSync(destination, { recursive: true, force: false });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    updated = true;
  }

  return updated;
}

function syncPluginScripts(projectRoot = process.cwd()) {
  const scriptsDir = path.join(projectRoot, 'scripts');
  const pluginScriptsDir = path.join(projectRoot, 'plugin', 'scripts');
  rebuildMcpBundle(projectRoot);
  const deployGroups = collectDeployGroups(fs, path, scriptsDir, {
    excludedScripts: PLUGIN_EXCLUDED_SCRIPTS,
    includeNestedDirs: ['core', 'engines'],
  });

  let updated = false;
  for (const group of deployGroups) {
    const destDir = group.destSubdir ? path.join(pluginScriptsDir, group.destSubdir) : pluginScriptsDir;
    updated = syncDirFiles(group.srcDir, destDir, {
      fileList: group.fileList,
      cleanupStale: true,
      cleanupExclusions: PLUGIN_EXCLUDED_SCRIPTS,
    }) || updated;
  }

  updated = syncDirFiles(path.join(scriptsDir, 'hooks'), path.join(pluginScriptsDir, 'hooks'), {
    cleanupStale: true,
  }) || updated;
  // The runtime resolves this adapter relative to plugin/scripts. Other bin
  // utilities are source-maintainer commands and must not be distributed.
  updated = syncDirFiles(path.join(scriptsDir, 'bin'), path.join(pluginScriptsDir, 'bin'), {
    fileList: ['agy-adapter.js'],
    cleanupStale: true,
  }) || updated;
  updated = syncDirFiles(scriptsDir, pluginScriptsDir, {
    fileList: [MCP_BUNDLE_NOTICE],
  }) || updated;
  updated = syncPluginManifest(projectRoot) || updated;
  updated = syncProjectSkillEntrypoints(projectRoot) || updated;
  return updated;
}

if (require.main === module) {
  syncPluginScripts(process.cwd());
  console.log('Plugin scripts synced');
}

module.exports = {
  rebuildMcpBundle,
  syncPluginScripts,
  syncDirFiles,
  syncPluginManifest,
  syncProjectSkillEntrypoints,
};

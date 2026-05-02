'use strict';

const fs = require('fs');
const path = require('path');

const { collectDeployGroups } = require('./deploy-manifest');

// Files whose extension we consider "managed" by the sync flow. Stale-dest
// cleanup only ever deletes files matching this pattern, so unrelated dest
// artifacts (README, package.json, etc.) are never touched.
const MANAGED_EXT_RE = /\.(js|yaml|sh)$/;
const TEST_FILE_RE = /\.test\.js$/;

function syncDirFiles(srcDir, destDir, { fileList, chmod, cleanupStale, cleanupExclusions } = {}) {
  if (!fs.existsSync(srcDir)) return false;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let updated = false;
  const files = fileList || fs.readdirSync(srcDir).filter((f) => fs.statSync(path.join(srcDir, f)).isFile());
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
      if (TEST_FILE_RE.test(entry)) continue;
      if (!MANAGED_EXT_RE.test(entry)) continue;
      try {
        fs.unlinkSync(full);
        updated = true;
      } catch { /* ignore — best-effort cleanup */ }
    }
  }

  return updated;
}

const PLUGIN_EXCLUDED_SCRIPTS = new Set(['sync-readme.js', 'test_daemon.js', 'daemon.yaml']);

function syncPluginScripts(projectRoot = process.cwd()) {
  const scriptsDir = path.join(projectRoot, 'scripts');
  const pluginScriptsDir = path.join(projectRoot, 'plugin', 'scripts');
  const deployGroups = collectDeployGroups(fs, path, scriptsDir, {
    excludedScripts: PLUGIN_EXCLUDED_SCRIPTS,
    includeNestedDirs: ['core'],
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
  return updated;
}

if (require.main === module) {
  syncPluginScripts(process.cwd());
  console.log('Plugin scripts synced');
}

module.exports = {
  syncPluginScripts,
  syncDirFiles,
};

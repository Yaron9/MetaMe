'use strict';

const fs = require('fs');
const path = require('path');

const { collectDeployGroups } = require('./deploy-manifest');

function syncDirFiles(srcDir, destDir, { fileList, chmod } = {}) {
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
  return updated;
}

function syncPluginScripts(projectRoot = process.cwd()) {
  const scriptsDir = path.join(projectRoot, 'scripts');
  const pluginScriptsDir = path.join(projectRoot, 'plugin', 'scripts');
  const deployGroups = collectDeployGroups(fs, path, scriptsDir, {
    excludedScripts: new Set(['sync-readme.js', 'test_daemon.js', 'daemon.yaml']),
    includeNestedDirs: ['core'],
  });

  let updated = false;
  for (const group of deployGroups) {
    const destDir = group.destSubdir ? path.join(pluginScriptsDir, group.destSubdir) : pluginScriptsDir;
    updated = syncDirFiles(group.srcDir, destDir, { fileList: group.fileList }) || updated;
  }

  updated = syncDirFiles(path.join(scriptsDir, 'hooks'), path.join(pluginScriptsDir, 'hooks')) || updated;
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

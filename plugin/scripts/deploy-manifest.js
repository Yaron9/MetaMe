'use strict';

function collectFilesInDir(fs, path, srcDir, opts = {}) {
  const excludedScripts = opts.excludedScripts || new Set();
  const applyExclusions = opts.applyExclusions === true;
  const files = [];
  for (const entry of fs.readdirSync(srcDir)) {
    const fullPath = path.join(srcDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;
    if (applyExclusions && excludedScripts.has(entry)) continue;
    if (/\.test\.js$/.test(entry)) continue;
    if (!/\.(js|yaml|sh)$/.test(entry)) continue;
    files.push(entry);
  }
  return files;
}

function collectNestedGroups(fs, path, rootDir, destPrefix = '') {
  const groups = [];
  const entries = fs.readdirSync(rootDir);
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const childPrefix = destPrefix ? path.join(destPrefix, entry) : entry;
      groups.push(...collectNestedGroups(fs, path, fullPath, childPrefix));
      continue;
    }
    if (/\.test\.js$/.test(entry)) continue;
    if (!/\.(js|yaml|sh)$/.test(entry)) continue;
    files.push(entry);
  }

  groups.unshift({
    srcDir: rootDir,
    destSubdir: destPrefix,
    fileList: files,
  });
  return groups;
}

function collectDeployGroups(fs, path, scriptsDir, opts = {}) {
  const excludedScripts = opts.excludedScripts || new Set();
  const includeNestedDirs = Array.isArray(opts.includeNestedDirs) ? opts.includeNestedDirs : [];

  try {
    fs.statSync(scriptsDir);
  } catch {
    return [];
  }

  const groups = [];
  groups.push({
    srcDir: scriptsDir,
    destSubdir: '',
    fileList: collectFilesInDir(fs, path, scriptsDir, { excludedScripts, applyExclusions: true }),
  });

  for (const dirName of includeNestedDirs) {
    const srcDir = path.join(scriptsDir, dirName);
    try {
      if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    groups.push(...collectNestedGroups(fs, path, srcDir, dirName));
  }

  return groups;
}

function collectSyntaxCheckFiles(path, deployGroups) {
  const files = [];
  for (const group of deployGroups || []) {
    for (const file of group.fileList || []) {
      if (!file.endsWith('.js')) continue;
      files.push(path.join(group.srcDir, file));
    }
  }
  return files;
}

module.exports = {
  collectDeployGroups,
  collectSyntaxCheckFiles,
  collectNestedGroups,
};

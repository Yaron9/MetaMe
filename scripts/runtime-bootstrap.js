'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

function readRuntimeEnvFile(baseDir) {
  const runtimeFile = path.join(baseDir, 'runtime-env.json');
  try {
    if (!fs.existsSync(runtimeFile)) return null;
    return JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  } catch {
    return null;
  }
}

function collectNodeModuleCandidates(baseDir) {
  const candidates = [];
  const runtimeEnv = readRuntimeEnvFile(baseDir);
  const metameRoot = String(process.env.METAME_ROOT || runtimeEnv?.metameRoot || '').trim();
  const runtimeNodeModules = String(runtimeEnv?.nodeModules || '').trim();

  if (runtimeNodeModules) candidates.push(runtimeNodeModules);
  if (metameRoot) candidates.push(path.join(metameRoot, 'node_modules'));

  candidates.push(path.join(baseDir, 'node_modules'));
  candidates.push(path.resolve(baseDir, '..', 'node_modules'));

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (home) candidates.push(path.join(home, '.metame', 'node_modules'));

  return [...new Set(candidates.filter(Boolean))];
}

function bootstrapRuntimeModulePaths(baseDir = __dirname) {
  const runtimeEnv = readRuntimeEnvFile(baseDir);
  if (!process.env.METAME_ROOT && runtimeEnv?.metameRoot) {
    process.env.METAME_ROOT = runtimeEnv.metameRoot;
  }

  const existingNodePath = String(process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map(p => p.trim())
    .filter(Boolean);

  let updated = false;
  for (const candidate of collectNodeModuleCandidates(baseDir)) {
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existingNodePath.includes(candidate)) {
      existingNodePath.unshift(candidate);
      updated = true;
    }
    if (!Module.globalPaths.includes(candidate)) {
      Module.globalPaths.unshift(candidate);
      updated = true;
    }
  }

  if (updated) {
    process.env.NODE_PATH = existingNodePath.join(path.delimiter);
    if (typeof Module._initPaths === 'function') Module._initPaths();
  }

  return {
    metameRoot: process.env.METAME_ROOT || '',
    nodePath: process.env.NODE_PATH || '',
  };
}

module.exports = {
  bootstrapRuntimeModulePaths,
};

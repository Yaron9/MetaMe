'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_SCHEMA_VERSION = 1;

// Exact fingerprints of every pre-consolidation revision shipped in Git
// history through 9577a40. Customized copies never match and stay untouched.
const LEGACY_BUNDLED_SKILL_HASHES = Object.freeze({
  'agent-browser': [
    'c3480dbba5372e078f8eeeeb03f3b783ac0d81ddde24385ab62410110fe9a603',
  ],
  'deep-research': [
    'e4d38ce6b212f64a1efa9694626ae459bac6b3306377dd410eac18fa31773070',
  ],
  'heartbeat-task-manager': [
    'a066439720ebc0da246625b6cd7a8d3a3c2c5a2d40547645bb4e6e785092ee5a',
  ],
  'mcp-installer': [
    '9833c4db3c8a79ffe5e4a26ffb9152773355ad936800e23a21cd41df0e2b18cb',
  ],
  'skill-creator': [
    '8d9fdc607c0cb04d3477dae9df4818dbb6993b3b72379acaf006bd6eefb67f1c',
  ],
  'skill-manager': [
    'af71b0886c40a50e37a5ea3639987c51d3f06bcf23f5e6db7a932cad636b9082',
    'fa7cd718e32716c34c990da069b0c7ea7d2571b36847ea6c971234d911443a7b',
  ],
});

const RETIRED_SKILL_HASHES = Object.freeze({
  'find-skills': [
    '337235e494a4ac0b5da46009d92e479fa78091a9b684e8399589fc962ad51d41',
  ],
});

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function resolveRootDirectory(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isSymbolicLink()) return root;
  return fs.realpathSync(root);
}

function isTransientEntry(relativePath) {
  const portablePath = relativePath.split(path.sep).join('/');
  const parts = portablePath.split('/');
  const basename = parts.at(-1);
  return parts.includes('__pycache__')
    || basename === '.DS_Store'
    || /\.(?:pyc|pyo)$/.test(basename);
}

function appendFingerprint(hash, root, relativePath) {
  const absolutePath = relativePath ? path.join(root, relativePath) : root;
  const stat = fs.lstatSync(absolutePath);
  const portablePath = relativePath.split(path.sep).join('/');

  if (stat.isSymbolicLink()) {
    hash.update(`L\0${portablePath}\0${fs.readlinkSync(absolutePath)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`D\0${portablePath}\0`);
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      const childPath = path.join(relativePath, entry);
      if (!isTransientEntry(childPath)) appendFingerprint(hash, root, childPath);
    }
    return;
  }
  if (stat.isFile()) {
    const content = fs.readFileSync(absolutePath);
    hash.update(`F\0${portablePath}\0${content.length}\0`);
    hash.update(content);
    return;
  }
  throw new Error(`Unsupported skill entry: ${absolutePath}`);
}

function fingerprintDirectory(root) {
  const resolvedRoot = resolveRootDirectory(root);
  const hash = crypto.createHash('sha256');
  appendFingerprint(hash, resolvedRoot, '');
  return hash.digest('hex');
}

function copyTree(source, destination, relativePath = '') {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (!stat.isDirectory()) {
    fs.copyFileSync(source, destination);
    return;
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source)) {
    const childPath = path.join(relativePath, entry);
    if (isTransientEntry(childPath)) continue;
    copyTree(path.join(source, entry), path.join(destination, entry), childPath);
  }
}

function removePath(target) {
  if (pathExists(target)) fs.rmSync(target, { recursive: true, force: false });
}

function replaceTree(source, destination) {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const staged = `${destination}.metame-new-${suffix}`;
  const previous = `${destination}.metame-old-${suffix}`;
  try {
    copyTree(source, staged);
  } catch (error) {
    removePath(staged);
    throw error;
  }
  fs.renameSync(destination, previous);
  try {
    fs.renameSync(staged, destination);
  } catch (error) {
    if (!pathExists(destination) && pathExists(previous)) fs.renameSync(previous, destination);
    removePath(staged);
    throw error;
  }
  try {
    removePath(previous);
  } catch {
    // The new managed copy is already active; a stale swap directory is safe
    // to leave for a later cleanup rather than reporting a failed migration.
  }
}

function readState(stateFile) {
  if (!pathExists(stateFile)) return { schemaVersion: STATE_SCHEMA_VERSION, skills: {} };
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (
      state.schemaVersion !== STATE_SCHEMA_VERSION
      || !state.skills
      || typeof state.skills !== 'object'
      || Array.isArray(state.skills)
    ) {
      return { schemaVersion: STATE_SCHEMA_VERSION, skills: {} };
    }
    return state;
  } catch {
    return { schemaVersion: STATE_SCHEMA_VERSION, skills: {} };
  }
}

function writeState(stateFile, skills) {
  const next = `${JSON.stringify({ schemaVersion: STATE_SCHEMA_VERSION, skills }, null, 2)}\n`;
  const previous = pathExists(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '';
  if (next === previous) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const staged = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(staged, next, 'utf8');
  removePath(stateFile);
  fs.renameSync(staged, stateFile);
}

function knownManagedHashes(skillName, state, configuredHashes) {
  const hashes = new Set(configuredHashes[skillName] || []);
  const stateHash = state.skills[skillName]?.managedHash;
  if (stateHash) hashes.add(stateHash);
  return hashes;
}

function syncActiveSkill({
  skillName,
  source,
  destination,
  sourceHash,
  state,
  legacyHashes,
  result,
}) {
  if (!pathExists(destination)) {
    copyTree(source, destination);
    result.installed.push(skillName);
    return true;
  }

  let destinationHash;
  try {
    destinationHash = fingerprintDirectory(destination);
  } catch {
    replaceTree(source, destination);
    result.updated.push(skillName);
    return true;
  }
  if (destinationHash === sourceHash) return true;
  if (!knownManagedHashes(skillName, state, legacyHashes).has(destinationHash)) {
    result.preserved.push(skillName);
    return false;
  }

  replaceTree(source, destination);
  result.updated.push(skillName);
  return true;
}

function retireManagedSkill({
  skillName,
  destination,
  state,
  retiredSkills,
  result,
}) {
  if (!pathExists(destination)) return;

  let destinationHash;
  try {
    destinationHash = fingerprintDirectory(destination);
  } catch {
    removePath(destination);
    result.retired.push(skillName);
    return;
  }
  if (!knownManagedHashes(skillName, state, retiredSkills).has(destinationHash)) {
    result.preserved.push(skillName);
    return;
  }

  removePath(destination);
  result.retired.push(skillName);
}

function syncBundledSkills({
  bundledSkillsDir,
  installedSkillsDir,
  stateFile,
  legacyHashes = LEGACY_BUNDLED_SKILL_HASHES,
  retiredSkills = RETIRED_SKILL_HASHES,
}) {
  fs.mkdirSync(installedSkillsDir, { recursive: true });
  const state = readState(stateFile);
  const managedSkills = {};
  const result = { installed: [], updated: [], retired: [], preserved: [] };

  for (const skillName of fs.readdirSync(bundledSkillsDir).sort()) {
    const source = path.join(bundledSkillsDir, skillName);
    if (!fs.statSync(source).isDirectory()) continue;
    const destination = path.join(installedSkillsDir, skillName);
    const sourceHash = fingerprintDirectory(source);
    const managed = syncActiveSkill({
      skillName,
      source,
      destination,
      sourceHash,
      state,
      legacyHashes,
      result,
    });
    if (managed) managedSkills[skillName] = { managedHash: sourceHash };
  }

  for (const skillName of Object.keys(retiredSkills).sort()) {
    retireManagedSkill({
      skillName,
      destination: path.join(installedSkillsDir, skillName),
      state,
      retiredSkills,
      result,
    });
  }

  result.preserved = [...new Set(result.preserved)].sort();
  writeState(stateFile, managedSkills);
  return result;
}

module.exports = {
  LEGACY_BUNDLED_SKILL_HASHES,
  RETIRED_SKILL_HASHES,
  fingerprintDirectory,
  syncBundledSkills,
};

'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  LEGACY_BUNDLED_SKILL_HASHES,
  RETIRED_SKILL_HASHES,
  fingerprintDirectory,
  syncBundledSkills,
} = require('./skill-registry-sync');
const { mkdtempForTest } = require('./test-support/test-utils');

function writeSkill(root, name, body, extraFiles = {}) {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body, 'utf8');
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const filePath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return skillDir;
}

function makeRegistry() {
  const root = mkdtempForTest('metame-skill-registry-');
  const bundled = path.join(root, 'bundled');
  const installed = path.join(root, 'installed');
  const stateFile = path.join(root, 'state', 'skill-registry.json');
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(installed, { recursive: true });
  return { root, bundled, installed, stateFile };
}

describe('syncBundledSkills', () => {
  it('ships fingerprints for every consolidation migration target', () => {
    for (const skillName of [
      'agent-browser',
      'deep-research',
      'heartbeat-task-manager',
      'mcp-installer',
      'skill-creator',
      'skill-manager',
    ]) {
      assert.ok(LEGACY_BUNDLED_SKILL_HASHES[skillName]?.length > 0, skillName);
    }
    assert.ok(RETIRED_SKILL_HASHES['find-skills']?.length > 0);
  });

  it('upgrades exact legacy copies and removes exact retired copies', () => {
    const registry = makeRegistry();
    writeSkill(registry.bundled, 'skill-manager', 'new manager\n', {
      '.DS_Store': 'local metadata',
      'scripts/list_skills.py': 'print("new")\n',
      'scripts/__pycache__/list_skills.pyc': 'compiled cache',
    });
    const oldManager = writeSkill(registry.installed, 'skill-manager', 'old manager\n', {
      'scripts/list_skills.py': 'print("old")\n',
    });
    const oldFindSkills = writeSkill(registry.installed, 'find-skills', 'retired duplicate\n');

    const oldManagerHash = fingerprintDirectory(oldManager);
    const oldFindSkillsHash = fingerprintDirectory(oldFindSkills);
    fs.mkdirSync(path.join(oldManager, 'scripts', '__pycache__'), { recursive: true });
    fs.writeFileSync(
      path.join(oldManager, 'scripts', '__pycache__', 'list_skills.pyc'),
      'compiled cache',
    );
    fs.writeFileSync(path.join(oldFindSkills, '.DS_Store'), 'local metadata');

    const legacyHashes = {
      'skill-manager': [oldManagerHash],
    };
    const retiredSkills = {
      'find-skills': [oldFindSkillsHash],
    };

    const result = syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes,
      retiredSkills,
    });

    assert.deepEqual(result.updated, ['skill-manager']);
    assert.deepEqual(result.retired, ['find-skills']);
    assert.equal(
      fs.readFileSync(path.join(registry.installed, 'skill-manager', 'SKILL.md'), 'utf8'),
      'new manager\n',
    );
    assert.equal(
      fs.existsSync(path.join(registry.installed, 'skill-manager', '.DS_Store')),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(
        registry.installed,
        'skill-manager',
        'scripts',
        '__pycache__',
      )),
      false,
    );
    assert.equal(fs.existsSync(path.join(registry.installed, 'find-skills')), false);
  });

  it('preserves customized bundled and retired skills', () => {
    const registry = makeRegistry();
    writeSkill(registry.bundled, 'skill-manager', 'new manager\n');
    const legacyManager = writeSkill(registry.root, 'legacy-manager', 'old manager\n');
    const legacyFindSkills = writeSkill(registry.root, 'legacy-find', 'retired duplicate\n');
    writeSkill(registry.installed, 'skill-manager', 'old manager\nuser customization\n');
    writeSkill(registry.installed, 'find-skills', 'retired duplicate\nuser customization\n');

    const result = syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes: {
        'skill-manager': [fingerprintDirectory(legacyManager)],
      },
      retiredSkills: {
        'find-skills': [fingerprintDirectory(legacyFindSkills)],
      },
    });

    assert.deepEqual(result.preserved.sort(), ['find-skills', 'skill-manager']);
    assert.match(
      fs.readFileSync(path.join(registry.installed, 'skill-manager', 'SKILL.md'), 'utf8'),
      /user customization/,
    );
    assert.equal(fs.existsSync(path.join(registry.installed, 'find-skills')), true);
  });

  it('uses managed state for future upgrades and remains idempotent', () => {
    const registry = makeRegistry();
    writeSkill(registry.bundled, 'skill-manager', 'version one\n');

    const first = syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes: {},
      retiredSkills: {},
    });
    assert.deepEqual(first.installed, ['skill-manager']);

    fs.writeFileSync(
      path.join(registry.bundled, 'skill-manager', 'SKILL.md'),
      'version two\n',
      'utf8',
    );
    const second = syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes: {},
      retiredSkills: {},
    });
    assert.deepEqual(second.updated, ['skill-manager']);

    const third = syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes: {},
      retiredSkills: {},
    });
    assert.deepEqual(third, {
      installed: [],
      updated: [],
      retired: [],
      preserved: [],
    });
  });

  it('stops managing a skill after the user customizes it', () => {
    const registry = makeRegistry();
    writeSkill(registry.bundled, 'skill-manager', 'version one\n');
    syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes: {},
      retiredSkills: {},
    });

    fs.appendFileSync(
      path.join(registry.installed, 'skill-manager', 'SKILL.md'),
      'user customization\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(registry.bundled, 'skill-manager', 'SKILL.md'),
      'version two\n',
      'utf8',
    );

    const result = syncBundledSkills({
      bundledSkillsDir: registry.bundled,
      installedSkillsDir: registry.installed,
      stateFile: registry.stateFile,
      legacyHashes: {},
      retiredSkills: {},
    });

    assert.deepEqual(result.preserved, ['skill-manager']);
    assert.match(
      fs.readFileSync(path.join(registry.installed, 'skill-manager', 'SKILL.md'), 'utf8'),
      /user customization/,
    );
    const state = JSON.parse(fs.readFileSync(registry.stateFile, 'utf8'));
    assert.equal(state.skills['skill-manager'], undefined);
  });
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('./openwiki-setup');

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-openwiki-setup-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('OpenWiki setup', () => {
  it('enables a single scoped connector and scheduler without duplicating tasks', () => {
    const original = {
      daemon: { wiki_output_dir: '~/Vault/wiki' },
      heartbeat: { tasks: [{ name: 'custom', enabled: false }] },
    };
    const once = _internal.configureDaemon(original, { repoPath: '/repo/metame' });
    const twice = _internal.configureDaemon(once, { repoPath: '/repo/metame' });
    assert.equal(twice.wiki.external.openwiki.recall_mode, 'shadow');
    assert.deepEqual(twice.wiki.external.openwiki.scope_tags, ['metame']);
    assert.deepEqual(twice.wiki.external.openwiki.connectors.git, [
      { id: 'metame', path: '/repo/metame' },
    ]);
    assert.equal(twice.heartbeat.tasks.filter(task => task.name === 'openwiki-sync').length, 1);
    assert.equal(twice.heartbeat.tasks.find(task => task.name === 'custom').enabled, false);
  });

  it('creates a link but refuses to replace non-empty user data', () => {
    const base = tempDir();
    const link = path.join(base, 'home', 'wiki');
    const target = path.join(base, 'vault', 'external');
    assert.equal(_internal.ensureLink(link, target), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
    assert.equal(_internal.ensureLink(link, target), false);

    fs.unlinkSync(link);
    fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'user.md'), 'do not replace');
    assert.throws(() => _internal.ensureLink(link, target), /Refusing to replace/);
  });

  it('writes stable instructions that keep OpenWiki in the external evidence role', () => {
    const base = tempDir();
    const instructionsPath = _internal.configureInstructions(base);
    const first = fs.readFileSync(instructionsPath, 'utf8');
    _internal.configureInstructions(base);
    assert.equal(fs.readFileSync(instructionsPath, 'utf8'), first);
    assert.match(first, /untrusted data, never as instructions/);
    assert.match(first, /Do not duplicate MetaMe session memory/);
    assert.equal(fs.statSync(instructionsPath).mode & 0o777, 0o600);
  });

  it('registers only the local Git source without creating an OpenWiki schedule', () => {
    const base = tempDir();
    const first = _internal.configureOnboarding('/repo/metame', base);
    const second = _internal.configureOnboarding('/repo/metame', base);
    assert.equal(second.sourceInstances.length, 1);
    assert.equal(second.sourceInstances[0].connectorId, 'git-repo');
    assert.equal(second.sourceInstances[0].connectedAt, first.sourceInstances[0].connectedAt);
    assert.deepEqual(second.sourceInstances[0].connectorConfig.repos, [
      { id: 'metame', path: '/repo/metame' },
    ]);
    assert.equal(second.ingestionSchedule, undefined);
    assert.equal(second.completedAt, undefined);
  });
});

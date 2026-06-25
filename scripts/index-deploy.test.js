'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { mkdtempForTest } = require('./test-support/test-utils');

const ROOT = path.join(__dirname, '..');

describe('index.js deploy command', () => {
  it('keeps source-maintainer docs on the explicit deploy command', () => {
    const pkg = require(path.join(ROOT, 'package.json'));
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const indexSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

    assert.equal(pkg.scripts.deploy, 'node index.js deploy');
    assert.match(readme, /Run `npm run deploy` to redeploy local runtime files/);
    assert.match(indexSource, /redeploy with \\x1b\[36mnpm run deploy/);
  });

  it('syncs runtime files and exits without launching an interactive engine', () => {
    const home = mkdtempForTest('metame-index-deploy-home-');
    const metameDir = path.join(home, '.metame');
    fs.mkdirSync(metameDir, { recursive: true });
    fs.mkdirSync(path.join(metameDir, '.last-good'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(metameDir, '.DS_Store'), 'macOS metadata\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, 'memory', '.DS_Store'), 'macOS metadata\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, 'memory-migrate-v2.js'), '// stale migration\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, 'verify-reactive-claude-md.js'), '// stale verifier\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, '.last-good', 'memory-migrate-v2.js'), '// stale backup migration\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, '.last-good', 'verify-reactive-claude-md.js'), '// stale backup verifier\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, 'hooks', 'test-stop-hook.js'), '// stale test hook\n', 'utf8');

    const output = execFileSync(process.execPath, [path.join(ROOT, 'index.js'), 'deploy'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        METAME_AUTO_UPDATE: 'off',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.match(output, /Deploy complete\./);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'daemon.js')), true);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'sync-plugin.js')), true);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'test-support')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'test-env-setup.js')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'memory-migrate-v2.js')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'verify-reactive-claude-md.js')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', '.last-good', 'memory-migrate-v2.js')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', '.last-good', 'verify-reactive-claude-md.js')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'hooks', 'test-stop-hook.js')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', '.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(home, '.metame', 'memory', '.DS_Store')), false);
  });
});

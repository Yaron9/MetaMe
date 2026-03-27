'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneObsoleteMissions, scanLogs } = require('./ops-mission-queue');

function writeMissions(cwd, body) {
  fs.mkdirSync(path.join(cwd, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'workspace', 'missions.md'), body, 'utf8');
}

test('pruneObsoleteMissions removes resolved recurring errors and passing tests', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-queue-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-queue-metame-'));
  const prevMetameDir = process.env.METAME_DIR;

  try {
    process.env.METAME_DIR = metameDir;
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'events'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'scripts', 'passing.test.js'), 'const test = require("node:test"); test("ok", () => {});\n', 'utf8');
    fs.writeFileSync(path.join(metameDir, 'daemon.log'), '[2026-03-27T12:00:00Z] [INFO] healthy\n', 'utf8');
    writeMissions(cwd, [
      '# MetaMe Ops Missions',
      '',
      '## pending',
      '- [ops-1] Fix recurring error (4x): [<TS>] [WARN] Legacy warning still here',
      '- [ops-2] Fix failing tests in passing.test.js',
      '- [ops-3] bootstrap task that should remain',
      '',
      '## active',
      '',
      '## completed',
      '',
      '## abandoned',
      '',
    ].join('\n'));

    const result = pruneObsoleteMissions(cwd);
    assert.equal(result.pruned, 2);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    assert.doesNotMatch(content, /ops-1/);
    assert.doesNotMatch(content, /ops-2/);
    assert.match(content, /ops-3/);
  } finally {
    if (prevMetameDir === undefined) delete process.env.METAME_DIR;
    else process.env.METAME_DIR = prevMetameDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(metameDir, { recursive: true, force: true });
  }
});

test('scanLogs adds stable recurring-error missions after pruning', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-scan-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-scan-metame-'));
  const prevMetameDir = process.env.METAME_DIR;

  try {
    process.env.METAME_DIR = metameDir;
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'events'), { recursive: true });
    fs.writeFileSync(path.join(metameDir, 'daemon.log'), [
      '[2026-03-27T12:00:00Z] [WARN] Config mismatch in hook registry',
      '[2026-03-27T12:01:00Z] [WARN] Config mismatch in hook registry',
      '[2026-03-27T12:02:00Z] [WARN] Config mismatch in hook registry',
    ].join('\n'), 'utf8');
    writeMissions(cwd, [
      '# MetaMe Ops Missions',
      '',
      '## pending',
      '',
      '## active',
      '',
      '## completed',
      '',
      '## abandoned',
      '',
    ].join('\n'));

    const result = scanLogs(cwd);
    assert.equal(result.new_missions, 1);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    assert.match(content, /Fix recurring error: \[<TS>\] \[WARN\] Config mismatch in hook registry/);
  } finally {
    if (prevMetameDir === undefined) delete process.env.METAME_DIR;
    else process.env.METAME_DIR = prevMetameDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(metameDir, { recursive: true, force: true });
  }
});

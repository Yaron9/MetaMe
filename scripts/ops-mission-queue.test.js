'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pruneObsoleteMissions, scanLogs, completeBootstrapMission, nextMission } = require('./ops-mission-queue');

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

test('pruneObsoleteMissions completes an active mission whose test now passes', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-active-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-active-metame-'));
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
      '',
      '## active',
      '- [ops-9] Fix failing tests in passing.test.js (priority: 1)',
      '',
      '## completed',
      '',
      '## abandoned',
      '',
    ].join('\n'));

    const result = pruneObsoleteMissions(cwd);
    assert.equal(result.resolved, 1);
    assert.deepEqual(result.resolved_ids, ['ops-9']);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    const activeSection = content.split('## completed')[0];
    const completedSection = content.split('## completed')[1] || '';
    assert.doesNotMatch(activeSection, /ops-9/);
    assert.match(completedSection, /ops-9/);
  } finally {
    if (prevMetameDir === undefined) delete process.env.METAME_DIR;
    else process.env.METAME_DIR = prevMetameDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(metameDir, { recursive: true, force: true });
  }
});

test('nextMission skips an obsolete failing-tests mission and returns the next valid one', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-next-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-next-metame-'));
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
      '- [ops-a] Fix failing tests in passing.test.js (priority: 1)',
      '- [ops-b] Refactor the archiver module (priority: 2)',
      '',
      '## active',
      '',
      '## completed',
      '',
      '## abandoned',
      '',
    ].join('\n'));

    const result = nextMission(cwd);
    assert.equal(result.success, true);
    assert.equal(result.topic.id, 'ops-b');

    // The obsolete failing-tests mission must be dropped from pending.
    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    assert.doesNotMatch(content, /ops-a/);
    assert.match(content, /ops-b/);
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

test('scanLogs ignores recurring INFO-level lines (benign skips are not errors)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-info-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-info-metame-'));
  const prevMetameDir = process.env.METAME_DIR;

  try {
    process.env.METAME_DIR = metameDir;
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'events'), { recursive: true });
    // A benign, expected skip logged at INFO level, recurring well past the
    // error threshold. It contains the word "failed" but is NOT an error —
    // it must never spawn a "Fix recurring error" mission.
    fs.writeFileSync(path.join(metameDir, 'daemon.log'), [
      '[2026-05-26T12:00:00Z] [INFO] Precondition failed for cognitive-distill: file empty or missing',
      '[2026-05-26T14:00:00Z] [INFO] Precondition failed for cognitive-distill: file empty or missing',
      '[2026-05-26T16:00:00Z] [INFO] Precondition failed for cognitive-distill: file empty or missing',
      '[2026-05-26T18:00:00Z] [INFO] Precondition failed for cognitive-distill: file empty or missing',
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
    assert.equal(result.new_missions, 0);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    assert.doesNotMatch(content, /Fix recurring error/);
  } finally {
    if (prevMetameDir === undefined) delete process.env.METAME_DIR;
    else process.env.METAME_DIR = prevMetameDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(metameDir, { recursive: true, force: true });
  }
});

test('scanLogs ignores recurring watchdog timeout kills (expected protective behavior)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-watchdog-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-watchdog-metame-'));
  const prevMetameDir = process.env.METAME_DIR;

  try {
    process.env.METAME_DIR = metameDir;
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'events'), { recursive: true });
    // The streaming watchdog kills idle/stalled Claude subprocesses by design.
    // It logs at WARN for observability, but a busy chat hitting the idle/tool/
    // ceiling timeout repeatedly is expected operational behavior, NOT a code
    // defect — it must never spawn a "Fix recurring error" repair mission.
    fs.writeFileSync(path.join(metameDir, 'daemon.log'), [
      '[2026-06-05T07:40:46Z] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
      '[2026-06-06T00:23:53Z] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
      '[2026-06-06T00:26:15Z] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
      '[2026-06-06T01:00:00Z] [WARN] [claude] tool timeout for chatId oc_5d76f02c21203c5ae1c19fd83c790ba4 — killing process group',
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
    assert.equal(result.new_missions, 0);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    assert.doesNotMatch(content, /Fix recurring error/);
  } finally {
    if (prevMetameDir === undefined) delete process.env.METAME_DIR;
    else process.env.METAME_DIR = prevMetameDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(metameDir, { recursive: true, force: true });
  }
});

test('pruneObsoleteMissions drops an existing watchdog-timeout repair mission', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-watchdog-prune-'));
  const metameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-watchdog-prune-metame-'));
  const prevMetameDir = process.env.METAME_DIR;

  try {
    process.env.METAME_DIR = metameDir;
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(metameDir, 'events'), { recursive: true });
    fs.writeFileSync(path.join(metameDir, 'daemon.log'), [
      '[2026-06-05T07:40:46Z] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
      '[2026-06-06T00:23:53Z] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
      '[2026-06-06T00:26:15Z] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
    ].join('\n'), 'utf8');
    writeMissions(cwd, [
      '# MetaMe Ops Missions',
      '',
      '## pending',
      '- [ops-20260606-011] Fix recurring error: [<TS>] [WARN] [claude] idle timeout for chatId oc_942de23c38ff876f73f163052fbdb68f — killing process group',
      '',
      '## active',
      '',
      '## completed',
      '',
      '## abandoned',
      '',
    ].join('\n'));

    const result = pruneObsoleteMissions(cwd);
    assert.equal(result.pruned, 1);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    assert.doesNotMatch(content, /ops-20260606-011/);
  } finally {
    if (prevMetameDir === undefined) delete process.env.METAME_DIR;
    else process.env.METAME_DIR = prevMetameDir;
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(metameDir, { recursive: true, force: true });
  }
});

test('completeBootstrapMission moves active bootstrap mission to completed', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bootstrap-'));

  try {
    writeMissions(cwd, [
      '# MetaMe Ops Missions',
      '',
      '## pending',
      '- [ops-20260330-001] Fix recurring error: sample warning',
      '',
      '## active',
      '- [bootstrap-001] Scan daemon.log and events/ for recurring errors, produce initial diagnosis (priority: 1)',
      '',
      '## completed',
      '',
      '## abandoned',
      '',
    ].join('\n'));

    const result = completeBootstrapMission(cwd);
    assert.equal(result.completed, true);

    const content = fs.readFileSync(path.join(cwd, 'workspace', 'missions.md'), 'utf8');
    const activeSection = content.split('## completed')[0];
    const completedSection = content.split('## completed')[1] || '';
    assert.doesNotMatch(activeSection, /bootstrap-001/);
    assert.match(completedSection, /bootstrap-001/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

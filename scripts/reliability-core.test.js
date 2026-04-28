const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function mkHome(prefix = 'metame-reliability-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, '.metame'), { recursive: true });
  return home;
}

function homeEnv(home) {
  // On Windows, os.homedir() reads USERPROFILE, not HOME
  return process.platform === 'win32'
    ? { HOME: home, USERPROFILE: home }
    : { HOME: home };
}

function runNode(home, code, extraEnv = {}) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...process.env, ...homeEnv(home), ...extraEnv },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function installFakeClaude(home, body) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    const cli = path.join(bin, 'claude.cmd');
    fs.writeFileSync(cli, `@echo off\n${body}\n`, 'utf8');
    return { ...homeEnv(home), PATH: `${bin};${process.env.PATH}` };
  }
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!/bin/sh\n${body}\n`, 'utf8');
  fs.chmodSync(cli, 0o755);
  return { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}` };
}

function sendSignal(home, prompt, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'signal-capture.js')], {
      cwd: ROOT,
      env: { ...process.env, ...homeEnv(home), ...extraEnv },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('signal-capture timed out'));
    }, 10000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`signal-capture exited with ${code}`));
    });
    child.stdin.end(JSON.stringify({
      prompt,
      session_id: `s-${Math.random().toString(36).slice(2, 10)}`,
      cwd: '/tmp',
    }));
  });
}

test('signal-capture preserves all entries under concurrent writes', async () => {
  const home = mkHome();
  const count = 40;
  await Promise.all(
    Array.from({ length: count }, (_, i) => sendSignal(home, `请记住以后规则${i}`))
  );

  const buffer = path.join(home, '.metame', 'raw_signals.jsonl');
  const lines = fs.readFileSync(buffer, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, count);
  const prompts = new Set(lines.map((l) => JSON.parse(l).prompt));
  assert.equal(prompts.size, count);
});

test('distill keeps raw_signals when model returns malformed output', () => {
  const home = mkHome();
  const env = installFakeClaude(home, 'echo "MALFORMED_OUTPUT"');
  const buffer = path.join(home, '.metame', 'raw_signals.jsonl');

  fs.writeFileSync(
    buffer,
    JSON.stringify({
      ts: new Date().toISOString(),
      prompt: '请记住以后都用中文并保持简洁',
      confidence: 'high',
      type: 'directive',
      session: 'sess-1',
      cwd: '/tmp',
    }) + '\n',
    'utf8'
  );

  runNode(home, `
    const { distill } = require('./scripts/distill');
    (async () => {
      const r = await distill();
      console.log(JSON.stringify(r));
    })().then(() => process.exit(0)).catch(() => process.exit(1));
  `, env);

  const lines = fs.readFileSync(buffer, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(JSON.parse(lines[0]).prompt, /以后都用中文/);
});

test('memory-extract does not mark session extracted when extraction fails', () => {
  const home = mkHome();
  const env = installFakeClaude(home, 'echo "downstream failure" 1>&2; exit 1');
  const projDir = path.join(home, '.claude', 'projects', 'demo');
  fs.mkdirSync(projDir, { recursive: true });
  const sessionId = 'session-retry-me';
  const sessionPath = path.join(projDir, `${sessionId}.jsonl`);

  const rows = [];
  for (let i = 0; i < 24; i++) {
    rows.push(JSON.stringify({
      type: 'user',
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      cwd: '/tmp/demo',
      message: { content: `这是一条用于memory extract回归测试的用户消息 ${i}，需要保留重试能力。` },
    }));
    rows.push(JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() + i * 1000 + 500).toISOString(),
      message: { content: [{ type: 'text', text: 'ack' }] },
    }));
  }
  fs.writeFileSync(sessionPath, rows.join('\n') + '\n', 'utf8');

  runNode(home, `
    const me = require('./scripts/memory-extract');
    (async () => {
      await me.run();
      const sa = require('./scripts/session-analytics');
      const remain = sa.findAllUnextractedSessions(50).map(s => s.session_id);
      console.log(JSON.stringify(remain));
    })().then(() => process.exit(0)).catch(() => process.exit(1));
  `, env);

  const remain = JSON.parse(
    runNode(home, `
      const sa = require('./scripts/session-analytics');
      console.log(JSON.stringify(sa.findAllUnextractedSessions(50).map(s => s.session_id)));
    `).trim()
  );
  assert.ok(remain.includes(sessionId));
});

test('memory-extract records codex provenance when no claude sessions exist', () => {
  const home = mkHome();
  const response = JSON.stringify({
    session_name: 'Codex provenance',
    facts: [{
      entity: 'MetaMe.memory.provenance',
      relation: 'arch_convention',
      value: 'MetaMe memory extraction records each Codex rollout as raw session provenance before saving extracted facts.',
      confidence: 'high',
      tags: ['memory', 'provenance'],
    }],
  });
  const env = installFakeClaude(home, `cat >/dev/null\nprintf '%s\\n' '${response}'`);
  const sessionId = 'codex-provenance-session';
  const dayDir = path.join(home, '.codex', 'sessions', '2026', '04', '28');
  fs.mkdirSync(dayDir, { recursive: true });
  const rolloutPath = path.join(dayDir, `rollout-2026-04-28T01-02-03-${sessionId}.jsonl`);
  const meta = {
    type: 'session_meta',
    payload: {
      id: sessionId,
      cwd: '/tmp/metame',
      model_provider: 'openai',
    },
  };
  fs.writeFileSync(rolloutPath, `${JSON.stringify(meta)}\n${'x'.repeat(1200)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(home, '.codex', 'history.jsonl'),
    JSON.stringify({
      session_id: sessionId,
      ts: 1777338123,
      text: '请把 Codex rollout provenance 接入 memory extract，并保持最小闭环。',
    }) + '\n',
    'utf8'
  );

  const rows = JSON.parse(runNode(home, `
    const me = require('./scripts/memory-extract');
    (async () => {
      await me.run();
      const { DatabaseSync } = require('node:sqlite');
      const path = require('path');
      const db = new DatabaseSync(path.join(process.env.HOME, '.metame', 'memory.db'));
      const sources = db.prepare('SELECT id, engine, session_id, status FROM session_sources').all();
      const facts = db.prepare("SELECT source_type, source_id FROM memory_items WHERE kind IN ('convention','insight')").all();
      db.close();
      console.log(JSON.stringify({ sources, facts }));
    })().then(() => process.exit(0)).catch((e) => {
      console.error(e.stack || e.message);
      process.exit(1);
    });
  `, env).trim().split('\n').pop());

  assert.equal(rows.sources.length, 1);
  assert.equal(rows.sources[0].engine, 'codex');
  assert.equal(rows.sources[0].session_id, sessionId);
  assert.equal(rows.sources[0].status, 'extracted');
  assert.equal(rows.facts.length, 1);
  assert.equal(rows.facts[0].source_type, 'codex');
  assert.equal(rows.facts[0].source_id, rows.sources[0].id);
});

test('skill-evolution keeps signals when haiku output is malformed', () => {
  const home = mkHome();
  const env = installFakeClaude(home, 'echo "NOT_JSON_BLOCK"');
  const skillDir = path.join(home, '.claude', 'skills', 'demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Demo Skill\n\nA sample skill.', 'utf8');

  const sigFile = path.join(home, '.metame', 'skill_signals.jsonl');
  const signals = [
    { ts: new Date().toISOString(), prompt: '请求1', outcome: 'error', skills_invoked: ['demo-skill'], has_tool_failure: true, error: 'x' },
    { ts: new Date().toISOString(), prompt: '请求2', outcome: 'error', skills_invoked: ['demo-skill'], has_tool_failure: true, error: 'y' },
    { ts: new Date().toISOString(), prompt: '请求3', outcome: 'error', skills_invoked: ['demo-skill'], has_tool_failure: true, error: 'z' },
  ];
  fs.writeFileSync(sigFile, signals.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');

  runNode(home, `
    const se = require('./scripts/skill-evolution');
    (async () => {
      await se.distillSkills();
    })().then(() => process.exit(0)).catch(() => process.exit(1));
  `, env);

  const lines = fs.readFileSync(sigFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
});

test('signal-capture: overflow entries are drained and merged on next lock acquisition', async () => {
  const home = mkHome();
  const bufferFile = path.join(home, '.metame', 'raw_signals.jsonl');
  const overflowFile = path.join(home, '.metame', 'raw_signals.overflow.jsonl');

  const makeEntry = (i) => JSON.stringify({
    ts: new Date().toISOString(), prompt: `以后记住规则${i}`, confidence: 'high',
    type: 'directive', session: null, cwd: '/tmp',
  });

  // Pre-populate main buffer (3 entries) and overflow (2 entries)
  fs.writeFileSync(bufferFile, [0, 1, 2].map(makeEntry).join('\n') + '\n', 'utf8');
  fs.writeFileSync(overflowFile, [100, 101].map(makeEntry).join('\n') + '\n', 'utf8');

  // One normal signal — should drain overflow inside the lock
  await sendSignal(home, '以后回复请保持简洁风格');

  const lines = fs.readFileSync(bufferFile, 'utf8').split('\n').filter(Boolean);
  // 3 existing + 2 overflow + 1 new = 6
  assert.equal(lines.length, 6);
  assert.equal(fs.existsSync(overflowFile), false, 'overflow file should be removed after drain');
});

test('signal-capture: overflow drain respects MAX_BUFFER_LINES cap', async () => {
  const home = mkHome();
  const MAX = 300;
  const bufferFile = path.join(home, '.metame', 'raw_signals.jsonl');
  const overflowFile = path.join(home, '.metame', 'raw_signals.overflow.jsonl');

  const makeEntry = (i) => JSON.stringify({
    ts: new Date().toISOString(), prompt: `以后偏好配置${i}`, confidence: 'normal',
    type: 'implicit', session: null, cwd: '/tmp',
  });

  // Fill main buffer to 297, overflow to 5 — combined 302 + 1 new → must cap to 300
  fs.writeFileSync(bufferFile, Array.from({ length: 297 }, (_, i) => makeEntry(i)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(overflowFile, Array.from({ length: 5 }, (_, i) => makeEntry(i + 1000)).join('\n') + '\n', 'utf8');

  await sendSignal(home, '以后总是用英文写注释');

  const lines = fs.readFileSync(bufferFile, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= MAX, `buffer must not exceed MAX_BUFFER_LINES (got ${lines.length})`);
  assert.equal(lines.length, MAX);
  assert.equal(fs.existsSync(overflowFile), false, 'overflow file should be removed after drain');
});

test('skill-evolution: overflow entries are drained and merged on next appendSkillSignal', () => {
  const home = mkHome();
  const sigFile = path.join(home, '.metame', 'skill_signals.jsonl');
  const overflowFile = path.join(home, '.metame', 'skill_signals.overflow.jsonl');

  const makeSignal = (i) => JSON.stringify({
    ts: new Date().toISOString(), prompt: `prompt-${i}`, outcome: 'success',
    skills_invoked: ['demo-skill'], has_tool_failure: false, error: null,
    output_excerpt: '', tools_used: [], files_modified: [], cwd: '/tmp',
  });

  fs.writeFileSync(sigFile, [0, 1, 2].map(makeSignal).join('\n') + '\n', 'utf8');
  fs.writeFileSync(overflowFile, [100, 101].map(makeSignal).join('\n') + '\n', 'utf8');

  runNode(home, `
    const se = require('./scripts/skill-evolution');
    const sig = {
      ts: new Date().toISOString(), prompt: 'new-signal', outcome: 'success',
      skills_invoked: ['demo-skill'], has_tool_failure: false, error: null,
      output_excerpt: '', tools_used: [], files_modified: [], cwd: '/tmp',
    };
    se.appendSkillSignal(sig);
    process.exit(0);
  `);

  const lines = fs.readFileSync(sigFile, 'utf8').split('\n').filter(Boolean);
  // 3 existing + 2 overflow + 1 new = 6
  assert.equal(lines.length, 6);
  assert.equal(fs.existsSync(overflowFile), false, 'overflow file should be removed after drain');
});

test('writeBrainFileSafe throws when lock cannot be acquired', () => {
  const home = mkHome();
  fs.writeFileSync(path.join(home, '.metame', 'brain.lock'), '99999', 'utf8');

  const out = runNode(home, `
    const { writeBrainFileSafe } = require('./scripts/utils');
    (async () => {
      try {
        await writeBrainFileSafe('x: 1\\n', process.env.HOME + '/profile.yaml');
        console.log('WROTE');
      } catch (e) {
        console.log('THREW');
      }
    })().then(() => process.exit(0)).catch(() => process.exit(1));
  `).trim();

  assert.equal(out, 'THREW');
  assert.equal(fs.existsSync(path.join(home, 'profile.yaml')), false);
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAudit } = require('./core/audit');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metame-audit-'));
}

describe('createAudit state store', () => {
  it('returns default state shape when state file is missing', () => {
    const dir = makeTempDir();
    const audit = createAudit({
      fs,
      logFile: path.join(dir, 'daemon.log'),
      stateFile: path.join(dir, 'state.json'),
      stdout: { isTTY: true, write() {} },
      stderr: { write() {} },
      usageRetentionDaysDefault: 14,
    });

    const state = audit.loadState();
    assert.equal(state.pid, null);
    assert.deepEqual(state.budget, { date: null, tokens_used: 0 });
    assert.equal(state.usage.retention_days, 14);
    assert.deepEqual(state.usage.categories, {});
    assert.deepEqual(state.usage.daily, {});
  });

  it('preserves newer cached budget and session data on save', () => {
    const dir = makeTempDir();
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      budget: { date: '2026-03-25', tokens_used: 100 },
      sessions: { a: { last_active: 100 } },
      usage: {
        retention_days: 30,
        categories: { coding: { total: 20, updated_at: '2026-03-25T10:00:00.000Z' } },
        daily: { '2026-03-25': { total: 20, coding: 20 } },
        updated_at: '2026-03-25T10:00:00.000Z',
      },
    }), 'utf8');

    const audit = createAudit({
      fs,
      logFile: path.join(dir, 'daemon.log'),
      stateFile,
      stdout: { isTTY: true, write() {} },
      stderr: { write() {} },
      usageRetentionDaysDefault: 30,
    });

    const current = audit.loadState();
    assert.equal(current.budget.tokens_used, 100);

    audit.saveState({
      budget: { date: '2026-03-25', tokens_used: 50 },
      sessions: { a: { last_active: 10 } },
      usage: {
        retention_days: 7,
        categories: { coding: { total: 5, updated_at: '2026-03-25T09:00:00.000Z' } },
        daily: { '2026-03-25': { total: 5, coding: 5 } },
        updated_at: '2026-03-25T09:00:00.000Z',
      },
    });

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.budget.tokens_used, 100);
    assert.equal(saved.sessions.a.last_active, 100);
    assert.equal(saved.usage.retention_days, 30);
    assert.equal(saved.usage.categories.coding.total, 20);
  });
});

describe('createAudit logger', () => {
  it('rotates oversized logs and mirrors to non-tty stdout', () => {
    const dir = makeTempDir();
    const logFile = path.join(dir, 'daemon.log');
    fs.writeFileSync(logFile, 'x'.repeat(32), 'utf8');

    let mirrored = '';
    const audit = createAudit({
      fs,
      logFile,
      stateFile: path.join(dir, 'state.json'),
      stdout: {
        isTTY: false,
        write(chunk) { mirrored += String(chunk); },
      },
      stderr: { write() {} },
      usageRetentionDaysDefault: 30,
    });

    audit.refreshLogMaxSize({ daemon: { log_max_size: 8 } });
    audit.log('INFO', 'hello world');

    const bakFile = logFile + '.bak';
    assert.equal(fs.existsSync(bakFile), true);
    assert.match(fs.readFileSync(logFile, 'utf8'), /\[INFO\] hello world/);
    assert.match(mirrored, /\[INFO\] hello world/);
  });
});

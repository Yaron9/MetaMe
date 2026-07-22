'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendAudit, readAuditTail, rotateIfNeeded } = require('./file-map-audit');

describe('file-map-audit', () => {
  it('appends JSONL, reads tail, skips torn lines, never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-audit-'));
    const file = path.join(dir, 'audit.jsonl');
    appendAudit({ fsx: fs }, file, { ts: 't1', event: 'propose' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    appendAudit({ fsx: fs }, file, { ts: 't2', event: 'execute' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'existing audit metadata is hardened');
    fs.appendFileSync(file, '{torn line\n');
    appendAudit({ fsx: fs }, file, { ts: 't3', event: 'restore' });

    const tail = readAuditTail({ fsx: fs }, file, 10);
    assert.deepEqual(tail.map(r => r.event), ['propose', 'execute', 'restore']);
    assert.deepEqual(readAuditTail({ fsx: fs }, file, 1).map(r => r.event), ['restore']);
    assert.deepEqual(readAuditTail({ fsx: fs }, '/nonexistent/audit.jsonl', 5), []);

    const blocked = appendAudit({ fsx: { statSync: () => { throw new Error('x'); }, appendFileSync: () => { throw new Error('disk full'); } } }, file, {});
    assert.equal(blocked, false, 'audit failure is reported, not thrown');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates when over maxBytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fmap-audit-'));
    const file = path.join(dir, 'audit.jsonl');
    fs.writeFileSync(file, 'x'.repeat(100));
    rotateIfNeeded({ fsx: fs }, file, 50);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(!fs.existsSync(file));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { _internal } = require('./wiki-doctor');

const tempFiles = [];
afterEach(() => {
  while (tempFiles.length) try { fs.rmSync(tempFiles.pop(), { recursive: true, force: true }); } catch { }
});

describe('wiki doctor reporting', () => {
  it('keeps the most severe status and renders Unix-friendly lines', () => {
    const report = { status: 'ok', checks: [] };
    _internal.addCheck(report, 'a', 'degraded', 'slow');
    _internal.addCheck(report, 'b', 'ok', 'fine');
    _internal.addCheck(report, 'c', 'error', 'broken');
    _internal.addCheck(report, 'd', 'degraded', 'still degraded');
    assert.equal(report.status, 'error');
    assert.match(_internal.renderHuman(report), /✗ c: broken/);
  });

  it('reads the latest valid JSONL entry and ignores a truncated tail', () => {
    const file = path.join(os.tmpdir(), `wiki-doctor-${process.pid}-${Date.now()}.jsonl`);
    tempFiles.push(file);
    fs.writeFileSync(file, '{"ts":"first"}\nnot-json\n{"ts":"latest"}\ntruncated');
    assert.equal(_internal.lastJsonLine(file).ts, 'latest');
  });

  it('diagnoses a pre-migration database instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-doctor-old-'));
    tempFiles.push(dir);
    const dbPath = path.join(dir, 'memory.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE wiki_pages (slug TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE memory_items (id TEXT PRIMARY KEY);
      CREATE TABLE content_chunks (id TEXT PRIMARY KEY);
      CREATE TABLE embedding_queue (id TEXT PRIMARY KEY);
    `);
    db.close();
    const report = { status: 'ok', checks: [], metrics: {} };
    _internal.inspectDatabase(report, { enabled: true, outputRoot: path.join(dir, 'wiki'), recall_mode: 'shadow' }, { dbPath });
    assert.equal(report.metrics.openwiki_pages, 0);
    assert.equal(report.checks.find(check => check.name === 'openwiki-schema').level, 'degraded');
  });

  it('marks parse_failed reflection records as unhealthy', () => {
    const file = path.join(os.tmpdir(), `wiki-doctor-reflect-${process.pid}-${Date.now()}.jsonl`);
    tempFiles.push(file);
    fs.writeFileSync(file, JSON.stringify({ status: 'error', reason: 'parse_failed' }) + '\n');
    const report = { status: 'ok', checks: [] };
    _internal.inspectReflection(report, file);
    assert.equal(report.checks[0].level, 'degraded');
    assert.match(report.checks[0].message, /failed/);
  });
});

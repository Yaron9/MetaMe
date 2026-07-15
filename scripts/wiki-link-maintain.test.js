'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditVault, maintainWikiLinks, repairWorkspace } = require('./wiki-link-maintain');

function vault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-links-'));
  fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(root, 'capsules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'capsules', '_index.md'), '# Capsules\n');
  return root;
}

function workspace(root, file) {
  fs.writeFileSync(path.join(root, '.obsidian', 'workspace.json'), JSON.stringify({
    main: { type: 'split', children: [{ type: 'leaf', state: { type: 'markdown', state: { file } } }] },
  }));
}

test('maintainWikiLinks is read-only by default and reports authored links', () => {
  const root = vault();
  try {
    const file = path.join(root, 'capsules', 'authored.md');
    fs.writeFileSync(file, '[[future-note]]\n![[photo.png]]\n');
    fs.writeFileSync(path.join(root, 'photo.png'), 'image');
    workspace(root, 'capsules/_index.md');
    const before = fs.readFileSync(file, 'utf8');
    const report = maintainWikiLinks(root);
    assert.equal(report.softBroken.length, 1);
    assert.equal(report.hardBroken.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('auditVault rejects a missing root', () => {
  assert.throws(() => auditVault(path.join(os.tmpdir(), `missing-${Date.now()}`)), /directory missing/);
});

test('workspace repair is explicit, backed up, and leaves Markdown untouched', () => {
  const root = vault();
  const backupDir = path.join(root, 'backups');
  try {
    const authored = path.join(root, 'capsules', 'authored.md');
    fs.writeFileSync(authored, '[[future-note]]\n');
    workspace(root, 'missing.md');
    const result = repairWorkspace(root, { backupDir, minStableMs: 0, confirmIdle: true });
    assert.equal(result.replaced, 1);
    assert.ok(fs.existsSync(result.backupPath));
    assert.equal(fs.readFileSync(authored, 'utf8'), '[[future-note]]\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.obsidian', 'workspace.json')))
      .main.children[0].state.state.file, 'capsules/_index.md');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace repair requires an explicit Obsidian-idle confirmation', () => {
  const root = vault();
  try {
    workspace(root, 'missing.md');
    assert.throws(() => repairWorkspace(root, { minStableMs: 0 }), /--confirm-idle/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('workspace repair aborts on concurrent modification', () => {
  const root = vault();
  try {
    workspace(root, 'missing.md');
    assert.throws(() => repairWorkspace(root, {
      backupDir: path.join(root, 'backups'),
      minStableMs: 0,
      confirmIdle: true,
      beforeWrite: () => fs.appendFileSync(path.join(root, '.obsidian', 'workspace.json'), ' '),
    }), /changed during repair/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG, expandHome, normalizeConfig, loadFileMapConfig } = require('./file-map-config');

const HOME = '/home/u';

describe('file-map-config normalize', () => {
  it('null input yields full defaults with ~ expanded', () => {
    const cfg = normalizeConfig(null, HOME);
    assert.deepEqual(cfg.roots, [HOME]);
    assert.ok(cfg.protectedPatterns.includes(`${HOME}/Library/**`));
    assert.ok(cfg.protectedPatterns.includes('**/.git/**'));
    assert.equal(cfg.protectRecentDays, 14);
    assert.equal(cfg.cleanup.method, 'quarantine');
    assert.equal(cfg.cleanup.maxBatchBytes, 50 * 1024 ** 3);
    assert.equal(cfg.overview.depth, 3);
    assert.equal(cfg.storage.minReportMb, 500);
    assert.equal(cfg.storage.duBudgetSeconds, 45);
    assert.equal(cfg.maintenance.maxDepth, 6);
    assert.equal(cfg.maintenance.snapshotTtlMs, 3600000);
    assert.equal(cfg.mole.enabled, true);
    assert.equal(cfg.mole.analyzeTimeoutMs, 120000);
  });

  it('user values override defaults, out-of-range numbers clamp', () => {
    const cfg = normalizeConfig({
      roots: ['~/Work'],
      protect_recent_days: 9999,
      cleanup: { method: 'trash', proposal_ttl_minutes: 1, max_batch_gb: 5000 },
      overview: { depth: 99 },
      storage: { min_report_mb: -10, du_budget_seconds: 9999, target_max_categories: 0 },
      maintenance: { recent_days: -1, max_depth: 99, max_entries: 5, budget_seconds: 999, max_candidates: 99999 },
      mole: { enabled: false, preview_timeout_seconds: 9999, max_returned_candidates: 0 },
    }, HOME);
    assert.deepEqual(cfg.roots, [`${HOME}/Work`]);
    assert.equal(cfg.protectRecentDays, 365, 'clamped to max');
    assert.equal(cfg.cleanup.method, 'trash');
    assert.equal(cfg.cleanup.proposalTtlMinutes, 5, 'clamped to min');
    assert.equal(cfg.cleanup.maxBatchBytes, 1000 * 1024 ** 3, 'gb clamped to 1000');
    assert.equal(cfg.overview.depth, 4, 'depth clamped to 4');
    assert.equal(cfg.storage.minReportMb, 0, 'report threshold permits explicit zero');
    assert.equal(cfg.storage.duBudgetSeconds, 120, 'storage scan budget matches the runtime cap');
    assert.equal(cfg.storage.targetMaxCategories, 1, 'target plan keeps at least one category');
    assert.equal(cfg.maintenance.recentDays, 0);
    assert.equal(cfg.maintenance.maxDepth, 12);
    assert.equal(cfg.maintenance.maxEntries, 100);
    assert.equal(cfg.maintenance.budgetMs, 120000);
    assert.equal(cfg.maintenance.maxCandidates, 20000);
    assert.equal(cfg.mole.enabled, false);
    assert.equal(cfg.mole.previewTimeoutMs, 900000);
    assert.equal(cfg.mole.maxReturnedCandidates, 1);
    // untouched sections keep defaults
    assert.equal(cfg.cleanup.quarantineDays, 30);
    assert.equal(cfg.protectedPatterns.length, DEFAULT_CONFIG.protected.length);
  });

  it('unknown cleanup method falls back to quarantine, empty lists fall back to defaults', () => {
    const cfg = normalizeConfig({ cleanup: { method: 'rm-rf' }, protected: [], roots: [42] }, HOME);
    assert.equal(cfg.cleanup.method, 'quarantine');
    assert.equal(cfg.protectedPatterns.length, DEFAULT_CONFIG.protected.length, 'empty protected list must not disable the net');
    assert.deepEqual(cfg.roots, [HOME], 'non-string roots dropped → defaults');
  });

  it('expandHome handles ~, ~/x and absolute paths', () => {
    assert.equal(expandHome('~', HOME), HOME);
    assert.equal(expandHome('~/Downloads', HOME), `${HOME}/Downloads`);
    assert.equal(expandHome('/etc', HOME), '/etc');
  });
});

describe('file-map-config load', () => {
  const yaml = require('../resolve-yaml');

  it('prefers user config, falls back to template, then pure defaults', () => {
    const files = { '/cfg/user.yaml': 'roots:\n  - "~/Only"\n', '/cfg/default.yaml': 'roots:\n  - "~/Tpl"\n' };
    const fakeFs = { readFileSync: (f) => { if (files[f]) return files[f]; throw new Error('ENOENT'); } };
    const base = { fs: fakeFs, yaml, home: HOME, configPath: '/cfg/user.yaml', defaultPath: '/cfg/default.yaml' };

    const user = loadFileMapConfig(base);
    assert.equal(user.source, 'user');
    assert.deepEqual(user.config.roots, [`${HOME}/Only`]);

    const tpl = loadFileMapConfig({ ...base, configPath: '/cfg/missing.yaml' });
    assert.equal(tpl.source, 'template');
    assert.deepEqual(tpl.config.roots, [`${HOME}/Tpl`]);

    const none = loadFileMapConfig({ ...base, configPath: '/x', defaultPath: '/y' });
    assert.equal(none.source, 'defaults');
    assert.deepEqual(none.config.roots, [HOME]);
  });

  it('invalid YAML degrades to safe defaults with ok:false', () => {
    const fakeFs = { readFileSync: () => 'roots: [unclosed' };
    const out = loadFileMapConfig({ fs: fakeFs, yaml, home: HOME, configPath: '/cfg/bad.yaml', defaultPath: null });
    assert.equal(out.ok, false);
    assert.match(out.error, /invalid YAML/);
    assert.deepEqual(out.config.roots, [HOME], 'still returns a usable safe config');
  });
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyReviewedDbCleanupPlan,
  applySafeFixPlan,
  buildReviewedDbCleanupPlan,
  buildSafeFixPlan,
  buildInventory,
  writeDbReviewBundle,
  writeDeprecationMarkers,
  writeAuditReport,
  writeCleanupManifest,
} = require('./core/wiki-audit');
const {
  formatCleanupManifestMarkdown,
  formatInventoryMarkdown,
  formatReviewedDbCleanupPlan,
  formatSafeFixPlanMarkdown,
} = require('./core/wiki-audit-format');

function openDefaultDb({ readOnly = true } = {}) {
  const dbPath = path.join(os.homedir(), '.metame', 'memory.db');
  if (!fs.existsSync(dbPath)) return null;
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly });
}

function main(argv = process.argv.slice(2)) {
  const wantsFixDryRun = argv.includes('--fix-safe') && argv.includes('--dry-run');
  const wantsFixApply = argv.includes('--fix-safe') && argv.includes('--apply');
  const wantsDbCleanupDryRun = argv.includes('--cleanup-db-duplicates') && argv.includes('--dry-run');
  const wantsDbCleanupApply = argv.includes('--cleanup-db-duplicates') && argv.includes('--apply');
  const confirmsDbCleanup = argv.includes('--confirm-reviewed-db-cleanup');
  const wantsReviewBundle = argv.includes('--write-review-bundle');
  const wantsDeprecationMarkers = argv.includes('--write-deprecation-markers');
  if (!argv.includes('--inventory') && !argv.includes('--cleanup-manifest') && !argv.includes('--write-cleanup-manifest') && !argv.includes('--write-audit') && !wantsReviewBundle && !wantsDeprecationMarkers && !wantsFixDryRun && !wantsFixApply && !wantsDbCleanupDryRun && !wantsDbCleanupApply) {
    console.log('Usage: node scripts/wiki-audit.js --inventory|--write-audit|--cleanup-manifest|--write-cleanup-manifest|--write-review-bundle|--write-deprecation-markers|--fix-safe --dry-run|--fix-safe --apply|--cleanup-db-duplicates --dry-run|--cleanup-db-duplicates --apply --confirm-reviewed-db-cleanup [--json]');
    return;
  }

  const db = openDefaultDb({ readOnly: !(wantsDbCleanupApply && confirmsDbCleanup) });
  try {
    const inventory = buildInventory({ db });
    let reviewFiles = [];
    if (wantsReviewBundle) {
      reviewFiles = writeDbReviewBundle(inventory, db);
    }
    let deprecationMarkers = [];
    if (wantsDeprecationMarkers) {
      deprecationMarkers = writeDeprecationMarkers(inventory);
    }
    if (wantsFixDryRun) {
      const plan = buildSafeFixPlan(inventory);
      console.log(argv.includes('--json') ? JSON.stringify(plan, null, 2) : formatSafeFixPlanMarkdown(plan));
      return;
    }
    if (wantsFixApply) {
      const result = applySafeFixPlan(buildSafeFixPlan(inventory));
      console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : formatSafeApplyResult(result));
      return;
    }
    if (wantsDbCleanupDryRun) {
      const plan = buildReviewedDbCleanupPlan(inventory);
      console.log(argv.includes('--json') ? JSON.stringify(plan, null, 2) : formatReviewedDbCleanupPlan(plan));
      return;
    }
    if (wantsDbCleanupApply) {
      const plan = buildReviewedDbCleanupPlan(inventory);
      const result = applyReviewedDbCleanupPlan(plan, db, { confirmed: confirmsDbCleanup });
      console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : formatSafeApplyResult(result));
      return;
    }

    if (argv.includes('--json')) {
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }

    if (argv.includes('--cleanup-manifest')) {
      console.log(formatCleanupManifestMarkdown(inventory));
      return;
    }

    const writtenFiles = [];
    if (wantsReviewBundle) {
      writtenFiles.push(`review bundle written: ${reviewFiles.length} files`);
      writtenFiles.push(...reviewFiles);
    }
    if (wantsDeprecationMarkers) {
      writtenFiles.push(`deprecation markers written: ${deprecationMarkers.length} files`);
      writtenFiles.push(...deprecationMarkers);
    }
    if (argv.includes('--write-cleanup-manifest')) {
      const filePath = writeCleanupManifest(inventory);
      writtenFiles.push(`cleanup manifest written: ${filePath}`);
    }

    if (argv.includes('--write-audit')) {
      const filePath = writeAuditReport(inventory);
      writtenFiles.push(`audit report written: ${filePath}`);
    }

    if (writtenFiles.length > 0) {
      console.log(writtenFiles.join('\n'));
      return;
    }

    console.log(formatInventoryMarkdown(inventory));
  } finally {
    if (db) db.close();
  }
}

if (require.main === module) main();

module.exports = require('./core/wiki-audit');

function formatSafeApplyResult(result) {
  const lines = [
    `applied: ${result.applied}`,
    `skipped: ${result.skipped}`,
  ];
  if (result.backupPath) lines.push(`backup: ${result.backupPath}`);
  for (const item of result.results || []) {
    lines.push(`- ${item.status}: ${item.action} ${item.target || ''}${item.reason ? ` (${item.reason})` : ''}`);
  }
  return lines.join('\n');
}

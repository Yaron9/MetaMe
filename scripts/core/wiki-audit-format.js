'use strict';

function formatInventoryMarkdown(inventory) {
  const lines = [
    '---',
    'title: Wiki Audit',
    'type: generated-audit',
    `updated: ${inventory.generatedAt.slice(0, 10)}`,
    '---',
    '',
    '# MetaMe Wiki Inventory', '', `Generated: ${inventory.generatedAt}`, '',
    '## Active Output Dir', '', `- ${inventory.activeOutputDir}`, `- markdown files: ${inventory.active.fileCount}`, '',
    '## Active Layout', '',
  ];
  for (const [kind, count] of Object.entries(inventory.active.byKind).sort()) lines.push(`- ${kind}: ${count}`);
  lines.push('', '## Quality Signals', '');
  lines.push(`- weird filenames: ${inventory.active.weirdFilenames.length}`);
  lines.push(`- missing frontmatter: ${inventory.active.missingFrontmatter.length}`);
  lines.push(`- empty frontmatter title: ${inventory.active.emptyTitle.length}`);
  lines.push(`- duplicate basenames: ${inventory.active.duplicateBasenames.length}`);
  lines.push(`- generated indexes: ${inventory.active.generatedIndexes.length}`);
  lines.push('', '## DB Quality Signals', '');
  if (!inventory.db || !inventory.db.checked) {
    lines.push(`- checked: no${inventory.db && inventory.db.error ? ` (${inventory.db.error})` : ''}`);
  } else {
    lines.push('- checked: yes');
    lines.push(`- wiki_pages rows: ${inventory.db.pageCount}`);
    lines.push(`- empty slugs: ${inventory.db.emptySlugs.length}`);
    lines.push(`- weird slugs: ${inventory.db.weirdSlugs.length}`);
    lines.push(`- missing exported files: ${inventory.db.missingExportFiles.length}`);
    lines.push(`- duplicate titles: ${inventory.db.duplicateTitles.length}`);
    lines.push(`- cleanup plans: ${inventory.db.cleanupPlans ? inventory.db.cleanupPlans.length : 0}`);
  }
  if (inventory.runtimeCopy) {
    lines.push('', '## Runtime Copy Evidence', '');
    lines.push(`- runtime wiki dir: ${inventory.runtimeCopy.runtimeWikiDir}`);
    lines.push(`- active uses runtime copy: ${inventory.runtimeCopy.activeUsesRuntimeCopy ? 'yes' : 'no'}`);
    if (inventory.runtimeCopy.classification) lines.push(`- classification: ${inventory.runtimeCopy.classification}`);
    lines.push(`- source references: ${inventory.runtimeCopy.referenceCount}`);
    if (inventory.runtimeCopy.configuredOutputRefs) lines.push(`- configured output refs: ${inventory.runtimeCopy.configuredOutputRefs.length}`);
    if (inventory.runtimeCopy.fallbackDefaultRefs) lines.push(`- fallback default refs: ${inventory.runtimeCopy.fallbackDefaultRefs.length}`);
    if (inventory.runtimeCopy.directRuntimeRefs) lines.push(`- direct runtime refs: ${inventory.runtimeCopy.directRuntimeRefs.length}`);
    lines.push(`- conclusion: ${inventory.runtimeCopy.conclusion}`);
    const sampleRefs = [
      ...(inventory.runtimeCopy.directRuntimeRefs || []).slice(0, 3),
      ...(inventory.runtimeCopy.fallbackDefaultRefs || []).slice(0, 3),
    ];
    for (const ref of sampleRefs) {
      lines.push(`- ${ref.file}:${ref.line} — ${ref.text}`);
    }
  }
  lines.push('', '## Output Dir Candidates', '');
  if (inventory.deprecatedOutputDirs.length === 0) lines.push('- none detected');
  for (const dir of inventory.deprecatedOutputDirs) {
    lines.push(`- ${dir.path} (${dir.label}, ${dir.role || 'unknown'}, ${dir.fileCount} md files)`);
    if (dir.deprecatedMarker) lines.push('  - deprecated marker: present');
  }
  lines.push('', '## Cleanup Candidates', '');
  if (inventory.cleanupCandidates.length === 0) lines.push('- none');
  for (const item of inventory.cleanupCandidates.slice(0, 50)) lines.push(`- ${item.action}: ${item.file} — ${item.reason}`);
  lines.push('');
  return lines.join('\n');
}

function actionSummary(action) {
  if (action === 'deprecate-dir') return 'Mark outside active wiki output; do not use as entrypoint.';
  if (action === 'deprecated-output-marked') return 'Already marked as deprecated; keep only for historical review until explicitly archived.';
  if (action === 'rename-or-archive') return 'Manual review before rename/archive; weird auto-generated slug.';
  if (action === 'quarantine-covered-weird-file') return 'Content is preserved in DB review bundle; review before moving out of active root.';
  if (action === 'merge-or-rename') return 'Review duplicates; merge content or disambiguate filenames.';
  if (action === 'inspect-db-row') return 'Review DB metadata before any migration; no automatic write proposed.';
  if (action === 'review-db-plan') return 'Review canonical row and protected cleanup plan before any DB migration.';
  if (action === 'review-runtime-copy') return 'Verify runtime readers before archive; do not treat as ordinary stale data.';
  if (action === 'preserve-runtime-fallback') return 'Do not archive while no-config fallback defaults still point here.';
  if (action === 'review-dir') return 'Review ownership before archive; no automatic change proposed.';
  return 'Inspect manually; no automatic change proposed.';
}

function retirementChecklist(action) {
  if (action === 'deprecate-dir' || action === 'deprecated-output-marked') {
    return [
      'Confirm active_output_dir is the only documented wiki entrypoint.',
      'Confirm no configured command, shortcut, or Obsidian workspace opens this directory.',
      'Archive or delete only after the deprecated marker has been reviewed.',
    ];
  }
  if (action === 'preserve-runtime-fallback' || action === 'review-runtime-copy') {
    return [
      'Keep while no-config fallback resolves to this directory.',
      'Retire only after fallback default is removed or redirected in core/wiki-paths.js.',
      'Before archive, run wiki audit and confirm active_output_dir is not this path.',
    ];
  }
  if (action === 'review-dir') {
    return [
      'Identify the owner and last writer before archive.',
      'Archive only after no active config or script references the directory.',
    ];
  }
  return [];
}

function formatCleanupManifestMarkdown(inventory) {
  const lines = [
    '---',
    'title: Wiki Cleanup Manifest',
    'type: generated-audit',
    `updated: ${inventory.generatedAt.slice(0, 10)}`,
    '---',
    '',
    '# MetaMe Wiki Cleanup Manifest',
    '',
    `Generated: ${inventory.generatedAt}`,
    '',
    '> Dry-run manifest. No files were moved, renamed, or deleted.',
    '',
    '## Active Output Dir',
    '',
    `- ${inventory.activeOutputDir}`,
    '',
    '## Output Dir Candidates',
    '',
  ];
  if (inventory.deprecatedOutputDirs.length === 0) lines.push('- none detected');
  for (const dir of inventory.deprecatedOutputDirs) {
    lines.push(`- ${dir.path}`);
    lines.push(`  - label: ${dir.label}`);
    lines.push(`  - role: ${dir.role || 'unknown'}`);
    lines.push(`  - markdown files: ${dir.fileCount}`);
    lines.push(`  - deprecated marker: ${dir.deprecatedMarker ? 'present' : 'absent'}`);
    lines.push(`  - recommended action: ${dir.recommendedAction || 'review-dir'}`);
    if (dir.reason) lines.push(`  - reason: ${dir.reason}`);
  }
  if (inventory.runtimeCopy) {
    lines.push('', '## Runtime Copy Evidence', '');
    lines.push(`- runtime wiki dir: ${inventory.runtimeCopy.runtimeWikiDir}`);
    lines.push(`- active uses runtime copy: ${inventory.runtimeCopy.activeUsesRuntimeCopy ? 'yes' : 'no'}`);
    if (inventory.runtimeCopy.classification) lines.push(`- classification: ${inventory.runtimeCopy.classification}`);
    lines.push(`- source references: ${inventory.runtimeCopy.referenceCount}`);
    if (inventory.runtimeCopy.configuredOutputRefs) lines.push(`- configured output refs: ${inventory.runtimeCopy.configuredOutputRefs.length}`);
    if (inventory.runtimeCopy.fallbackDefaultRefs) lines.push(`- fallback default refs: ${inventory.runtimeCopy.fallbackDefaultRefs.length}`);
    if (inventory.runtimeCopy.directRuntimeRefs) lines.push(`- direct runtime refs: ${inventory.runtimeCopy.directRuntimeRefs.length}`);
    lines.push(`- conclusion: ${inventory.runtimeCopy.conclusion}`);
  }
  lines.push('', '## Proposed Cleanup Actions', '');
  if (inventory.cleanupCandidates.length === 0) lines.push('- none');
  for (const item of inventory.cleanupCandidates) {
    lines.push(`- action: ${item.action}`);
    lines.push(`  target: ${item.file}`);
    lines.push(`  reason: ${item.reason}`);
    if (item.coveredByDbReview) {
      lines.push('  covered_by_db_review: yes');
      lines.push(`  canonical: ${item.coveredByDbReview.canonical || '(unknown)'}`);
      lines.push(`  source_row: ${item.coveredByDbReview.sourceRow || '(unknown)'}`);
      if (item.coveredByDbReview.reviewFile) lines.push(`  review_file: ${item.coveredByDbReview.reviewFile}`);
    }
    lines.push(`  note: ${actionSummary(item.action)}`);
    const checklist = retirementChecklist(item.action);
    if (checklist.length > 0) {
      lines.push('  retirement_gate:');
      for (const gate of checklist) lines.push(`    - ${gate}`);
    }
  }
  if (inventory.db && inventory.db.cleanupPlans && inventory.db.cleanupPlans.length > 0) {
    lines.push('', '## DB Cleanup Review', '');
    if (inventory.reviewedDbCleanupPlan && inventory.reviewedDbCleanupPlan.confirmationRequired) {
      lines.push('> Destructive DB cleanup is blocked unless the reviewed confirmation flag is passed.', '');
      lines.push(`- confirmation flag: ${inventory.reviewedDbCleanupPlan.confirmationFlag}`);
      lines.push(`- apply command: ${inventory.reviewedDbCleanupPlan.applyCommand}`);
      lines.push(`- backup dir: ${inventory.reviewedDbCleanupPlan.backupDir || '(unknown)'}`);
      lines.push('');
    } else {
      lines.push('> No protected DB cleanup command is currently available.', '');
    }
    for (const plan of inventory.db.cleanupPlans) {
      lines.push(`- title: ${plan.title}`);
      lines.push(`  action: ${plan.action}`);
      lines.push(`  keep: ${plan.keep || '(unknown)'}`);
      if (plan.keepContentHash) lines.push(`  keep_content: ${plan.keepContentHash} (${plan.keepContentLength || 0} chars)`);
      if (typeof plan.keepLineCount === 'number') lines.push(`  keep_lines: ${plan.keepLineCount}`);
      for (const row of plan.reviewRows) {
        lines.push(`  review row: ${row.slug || row.id || '(unknown)'}`);
        lines.push(`    reason: ${row.reason}`);
        if (row.contentHash) lines.push(`    content: ${row.contentHash} (${row.contentLength || 0} chars)`);
        if (typeof row.contentLineCount === 'number') lines.push(`    content_lines: ${row.contentLineCount}`);
        if (typeof row.contentCoveredByKeep === 'number') {
          lines.push(`    content_covered_by_keep: ${Math.round(row.contentCoveredByKeep * 100)}%`);
        }
        if (typeof row.contentMatchesKeep === 'boolean') {
          lines.push(`    content_matches_keep: ${row.contentMatchesKeep ? 'yes' : 'no'}`);
        }
        if (row.reviewFile) lines.push(`    review_file: ${row.reviewFile}`);
        if (row.suggestedSql) lines.push(`    suggested_sql: ${row.suggestedSql}`);
        if (!row.suggestedSql) lines.push('    suggested_sql: none; use reviewed cleanup command after confirmation');
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function formatSafeFixPlanMarkdown(plan) {
  const lines = [
    '---',
    'title: Wiki Safe Fix Plan',
    'type: generated-audit',
    `updated: ${plan.generatedAt.slice(0, 10)}`,
    '---',
    '',
    '# MetaMe Wiki Safe Fix Plan',
    '',
    `Generated: ${plan.generatedAt}`,
    '',
    '> Dry-run only. This plan does not delete, move, or rename files.',
    '',
    `Active output dir: ${plan.activeOutputDir}`,
    '',
    '## Actions',
    '',
  ];
  if (plan.actions.length === 0) lines.push('- none');
  for (const item of plan.actions) {
    lines.push(`- ${item.action}`);
    lines.push(`  - mode: ${item.mode}`);
    lines.push(`  - target: ${item.target}`);
    if (item.destination) lines.push(`  - destination: ${item.destination}`);
    if (item.expectedContentHash) lines.push(`  - expected content: ${item.expectedContentHash}`);
    lines.push(`  - reason: ${item.reason}`);
    if (Array.isArray(item.preconditions) && item.preconditions.length > 0) {
      lines.push(`  - preconditions: ${item.preconditions.join('; ')}`);
    }
    lines.push(`  - command: ${item.command || 'none; manual review required'}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatReviewedDbCleanupPlan(plan) {
  const lines = [
    '# Reviewed DB Duplicate Cleanup Plan',
    '',
    `Generated: ${plan.generatedAt}`,
    `Active output: ${plan.activeOutputDir}`,
    `Destructive: ${plan.destructive ? 'yes' : 'no'}`,
    `Confirmation required: ${plan.confirmationRequired ? plan.confirmationFlag : 'no'}`,
    `Backup dir: ${plan.backupDir || 'n/a'}`,
    '',
  ];
  if (!plan.actions || plan.actions.length === 0) {
    lines.push('No reviewed DB duplicate cleanup actions.');
    return lines.join('\n');
  }
  lines.push(`Apply command: ${plan.applyCommand}`);
  lines.push('');
  for (const action of plan.actions) {
    lines.push(`- ${action.mode}: ${action.action} ${action.sourceRowId} -> ${action.canonicalSlug}`);
    lines.push(`  reason: ${action.reason}`);
    lines.push(`  review_file: ${action.reviewFile}`);
    lines.push(`  expected_content_hash: ${action.expectedContentHash}`);
    lines.push(`  destructive: ${action.destructive ? 'yes' : 'no'}`);
  }
  return lines.join('\n');
}

module.exports = {
  formatCleanupManifestMarkdown,
  formatInventoryMarkdown,
  formatReviewedDbCleanupPlan,
  formatSafeFixPlanMarkdown,
};

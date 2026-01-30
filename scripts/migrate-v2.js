#!/usr/bin/env node

/**
 * MetaMe Profile Migration: v1 → v2
 *
 * Maps old structure to v2 schema:
 *   - status.focus → context.focus
 *   - status.language → preferences.language_mix (best guess)
 *   - Ensures all v2 sections exist with defaults
 *   - Preserves all existing data and LOCKED comments
 *
 * Usage: node migrate-v2.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BRAIN_FILE = path.join(os.homedir(), '.claude_profile.yaml');
const BACKUP_SUFFIX = '.v1.backup';
const DRY_RUN = process.argv.includes('--dry-run');

function migrate() {
  if (!fs.existsSync(BRAIN_FILE)) {
    console.log('No profile found. Nothing to migrate.');
    return;
  }

  const yaml = require('js-yaml');
  const rawContent = fs.readFileSync(BRAIN_FILE, 'utf8');
  const profile = yaml.load(rawContent) || {};

  // Check if already v2 (has context section)
  if (profile.context && profile.context.focus !== undefined) {
    console.log('Profile already appears to be v2. Skipping migration.');
    return;
  }

  console.log('Migrating profile from v1 to v2...');

  // --- Backup ---
  if (!DRY_RUN) {
    const backupPath = BRAIN_FILE + BACKUP_SUFFIX;
    fs.writeFileSync(backupPath, rawContent, 'utf8');
    console.log(`  Backup saved to: ${backupPath}`);
  }

  // --- Migration rules ---

  // 1. status.focus → context.focus
  if (profile.status && profile.status.focus) {
    if (!profile.context) profile.context = {};
    profile.context.focus = profile.status.focus;
    profile.context.focus_since = new Date().toISOString().slice(0, 10);
    delete profile.status.focus;
  }

  // 2. status.language → status.language (keep, it's in schema)
  // No change needed, status.language is valid in v2

  // 3. Clean up empty status object
  if (profile.status && Object.keys(profile.status).length === 0) {
    delete profile.status;
  }

  // 4. Ensure context section exists with defaults
  if (!profile.context) profile.context = {};
  if (profile.context.focus === undefined) profile.context.focus = null;
  if (profile.context.focus_since === undefined) profile.context.focus_since = null;
  if (profile.context.active_projects === undefined) profile.context.active_projects = [];
  if (profile.context.blockers === undefined) profile.context.blockers = [];
  if (profile.context.energy === undefined) profile.context.energy = null;

  // 5. Ensure evolution section exists
  if (!profile.evolution) profile.evolution = {};
  if (profile.evolution.last_distill === undefined) profile.evolution.last_distill = null;
  if (profile.evolution.distill_count === undefined) profile.evolution.distill_count = 0;
  if (profile.evolution.recent_changes === undefined) profile.evolution.recent_changes = [];

  // 6. Ensure preferences section exists (don't overwrite existing values)
  if (!profile.preferences) profile.preferences = {};

  // --- Output ---
  const dumped = yaml.dump(profile, { lineWidth: -1 });

  // Restore LOCKED comments from original
  const lockedLines = rawContent.split('\n').filter(l => l.includes('# [LOCKED]'));
  let restored = dumped;
  for (const lockedLine of lockedLines) {
    const match = lockedLine.match(/^\s*([\w_]+)\s*:\s*(.+?)\s+(#.+)$/);
    if (match) {
      const key = match[1];
      const comment = match[3];
      // Find the corresponding line in dumped output and append comment
      restored = restored.replace(
        new RegExp(`^(\\s*${key}\\s*:.+)$`, 'm'),
        (line) => line.includes('#') ? line : `${line} ${comment}`
      );
    }
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN (would write): ---');
    console.log(restored);
    console.log('--- END DRY RUN ---');
  } else {
    fs.writeFileSync(BRAIN_FILE, restored, 'utf8');
    console.log('  Migration complete. Profile is now v2.');
  }
}

migrate();

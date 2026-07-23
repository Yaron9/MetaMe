'use strict';

const { expandHome } = require('./file-map-config');

/**
 * file-map-storage.js — macOS storage assessment knowledge and planning.
 *
 * This module is deliberately pure. It describes known storage categories,
 * parses command output, and turns measured sizes into an advisory reclaim
 * plan. The MCP server owns every filesystem and process side effect.
 */

const CATEGORY_SPECS = [
  {
    id: 'trash',
    label: 'Trash',
    risk: 'low',
    recoverability: 'none_after_emptying',
    cleanup_route: 'finder_after_review',
    planningEligible: true,
    paths: ['~/.Trash'],
    warning: 'Emptying Trash is the final irreversible step; review its contents first.',
  },
  {
    id: 'downloads',
    label: 'Downloads and installers',
    risk: 'medium',
    recoverability: 'quarantine_selected_items',
    cleanup_route: 'scan_large_then_cleanup_pipeline',
    planningEligible: true,
    reclaimableViaPipeline: true,
    paths: ['~/Downloads'],
    scan_hint: { tool: 'scan_large', root: '~/Downloads', min_size_mb: 100 },
    warning: 'Do not remove the directory as a unit; review individual files, especially DMG, PKG and ZIP installers.',
  },
  {
    id: 'photos_media',
    label: 'Photos and media',
    risk: 'high',
    recoverability: 'review_in_originating_app',
    cleanup_route: 'optimize_or_review_in_app',
    planningEligible: true,
    paths: ['~/Pictures', '~/Movies', '~/Music'],
    warning: 'Libraries may be cloud-synced or managed by Photos, Music, iMovie or GarageBand.',
  },
  {
    id: 'mail_messages',
    label: 'Mail and Messages attachments',
    risk: 'high',
    recoverability: 'review_in_originating_app',
    cleanup_route: 'review_in_app',
    planningEligible: true,
    processes: ['Mail', 'Messages'],
    paths: [
      '~/Library/Mail',
      '~/Library/Messages/Attachments',
      '~/Library/Containers/com.apple.mail/Data/Library/Mail Downloads',
    ],
    warning: 'These paths are protected; prefer retention settings or deletion inside Mail and Messages.',
  },
  {
    id: 'browser_caches',
    label: 'Browser caches',
    risk: 'medium',
    recoverability: 'recreated_by_application',
    cleanup_route: 'scoped_adapter_required',
    planningEligible: true,
    processes: ['Safari', 'Google Chrome', 'Firefox', 'Brave Browser', 'Microsoft Edge'],
    paths: [
      '~/Library/Caches/com.apple.Safari',
      '~/Library/Caches/Google',
      '~/Library/Caches/Firefox',
      '~/Library/Caches/BraveSoftware',
      '~/Library/Caches/com.microsoft.edgemac',
    ],
    warning: 'Close the matching browser before clearing a cache; generic ~/Library cleanup remains forbidden.',
  },
  {
    id: 'cloud_storage',
    label: 'Cloud storage local data',
    risk: 'high',
    recoverability: 'provider_dependent',
    cleanup_route: 'provider_settings_only',
    planningEligible: false,
    paths: [
      '~/Library/CloudStorage',
      '~/Library/Mobile Documents/com~apple~CloudDocs',
      '~/.dropbox.cache',
    ],
    warning: 'Deleting a synced path may delete the cloud copy. Prefer Optimize Storage, online-only, or provider eviction controls.',
  },
  {
    id: 'ios_backups',
    label: 'iPhone and iPad backups',
    risk: 'medium',
    recoverability: 'backup_dependent',
    cleanup_route: 'finder_device_management',
    planningEligible: true,
    paths: ['~/Library/Application Support/MobileSync/Backup'],
    warning: 'Confirm the device and backup date in Finder before removing an old backup.',
  },
  {
    id: 'large_apps',
    label: 'Large applications',
    risk: 'high',
    recoverability: 'reinstall_required',
    cleanup_route: 'supported_uninstaller_or_finder',
    planningEligible: false,
    paths: ['/Applications'],
    scan_hint: { tool: 'file_search', root: '/Applications', kind: 'app', min_size_mb: 1000 },
    warning: 'Application size is advisory; use the vendor uninstaller when one exists.',
  },
  {
    id: 'old_installers',
    label: 'Old installers and archives',
    risk: 'medium',
    recoverability: 'quarantine_selected_items',
    cleanup_route: 'file_search_then_cleanup_pipeline',
    planningEligible: false,
    reclaimableViaPipeline: true,
    paths: [],
    scan_hint: { tool: 'file_search', root: '~/Downloads', name: '.dmg', min_size_mb: 100 },
    warning: 'Repeat the filename scan for .pkg and .zip, then review individual results.',
  },
  {
    id: 'screen_recordings',
    label: 'Screen recordings and desktop video',
    risk: 'high',
    recoverability: 'quarantine_selected_items',
    cleanup_route: 'file_search_then_cleanup_pipeline',
    planningEligible: false,
    reclaimableViaPipeline: true,
    paths: ['~/Desktop'],
    scan_hint: { tool: 'file_search', root: '~/Desktop', kind: 'video', min_size_mb: 100 },
    warning: 'The measured size is the whole Desktop; only individually reviewed videos are candidates.',
  },
  {
    id: 'application_caches',
    label: 'Application caches (aggregate)',
    risk: 'medium',
    recoverability: 'application_dependent',
    cleanup_route: 'scoped_adapter_required',
    planningEligible: false,
    overlaps: ['browser_caches', 'developer_tools'],
    paths: ['~/Library/Caches'],
    warning: 'Aggregate only and overlaps browser/developer categories; never delete this directory wholesale.',
  },
  {
    id: 'system_logs',
    label: 'System and user logs',
    risk: 'high',
    recoverability: 'not_guaranteed',
    cleanup_route: 'advisory_only',
    planningEligible: false,
    paths: ['~/Library/Logs', '/Library/Logs', '/private/var/log'],
    warning: 'Root-level Library and private system paths stay protected; report size only.',
  },
  {
    id: 'fonts_printers',
    label: 'Fonts and printer drivers',
    risk: 'high',
    recoverability: 'installer_or_backup_required',
    cleanup_route: 'system_settings_or_vendor_uninstaller',
    planningEligible: false,
    paths: ['~/Library/Fonts', '/Library/Fonts', '/Library/Printers'],
    warning: 'Never use blanket sudo removal; manage fonts and printer software through supported UI or uninstallers.',
  },
  {
    id: 'developer_tools',
    label: 'Developer tools and rebuildable caches',
    risk: 'medium',
    recoverability: 'usually_rebuildable_but_not_rollbackable',
    cleanup_route: 'tool_specific_review',
    planningEligible: true,
    processes: ['Docker', 'Xcode'],
    paths: [
      '~/Library/Developer/Xcode/DerivedData',
      '~/Library/Developer/Xcode/Archives',
      '~/Library/Developer/Xcode/iOS DeviceSupport',
      '~/Library/Developer/CoreSimulator',
      '~/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw',
      '~/Library/Caches/Homebrew',
      '~/Library/Caches/go-build',
      '~/.npm',
      '~/.pnpm-store',
      '~/.cargo/registry/cache',
      '~/.cargo/registry/src',
    ],
    warning: 'Only built-in typed adapters may execute here; all other developer caches remain report-only.',
  },
];

const MAINTENANCE_TOOLS = [
  { name: 'xcode-select', args: ['-p'] },
  { name: 'docker', args: ['--version'] },
  { name: 'brew', args: ['--version'] },
  { name: 'npm', args: ['--version'] },
  { name: 'pnpm', args: ['--version'] },
  { name: 'pip3', args: ['--version'] },
  { name: 'cargo', args: ['--version'] },
  { name: 'go', args: ['version'] },
];

function buildCatalog(home) {
  return CATEGORY_SPECS.map(spec => ({
    ...spec,
    paths: spec.paths.map(p => expandHome(p, home)),
    processes: spec.processes ? spec.processes.slice() : [],
    overlaps: spec.overlaps ? spec.overlaps.slice() : [],
  }));
}

function parseDfKb(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;
  const fields = lines[lines.length - 1].trim().split(/\s+/);
  if (fields.length < 6) return null;
  const totalKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  const availableKb = Number(fields[3]);
  if (![totalKb, usedKb, availableKb].every(Number.isFinite)) return null;
  const mountIndex = fields.length >= 9 ? 8 : 5;
  return {
    total_bytes: totalKb * 1024,
    used_bytes: usedKb * 1024,
    available_bytes: availableKb * 1024,
    capacity: fields[4],
    mount: fields.slice(mountIndex).join(' '),
  };
}

function parseSnapshots(stdout) {
  const items = String(stdout || '').split('\n').map(s => s.trim()).filter(s => /^com\.apple\./.test(s));
  return {
    count: items.length,
    time_machine_count: items.filter(s => /^com\.apple\.TimeMachine\./.test(s)).length,
    os_update_count: items.filter(s => /^com\.apple\.os\.update/.test(s)).length,
    items: items.slice(0, 50),
    truncated: items.length > 50 || undefined,
  };
}

function parseProcessList(stdout) {
  return String(stdout || '').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function runningForCategory(category, processes) {
  return category.processes.filter(name => {
    const needle = name.toLowerCase();
    return processes.some(p => {
      const basename = p.split('/').pop();
      return basename === needle || p.includes(`/${needle}.app/`);
    });
  });
}

function buildCategoryReports(catalog, kbByPath, { protectedMatch, runningProcesses = [] } = {}) {
  return catalog.map(category => {
    const paths = category.paths
      .filter(p => kbByPath.has(p))
      .map(p => ({
        path: p,
        bytes: kbByPath.get(p) * 1024,
        protected: protectedMatch ? !!protectedMatch(p) : undefined,
      }));
    return {
      id: category.id,
      label: category.label,
      risk: category.risk,
      recoverability: category.recoverability,
      cleanup_route: category.cleanup_route,
      planning_eligible: category.planningEligible,
      reclaimable_via_pipeline: !!category.reclaimableViaPipeline,
      total_bytes: paths.reduce((sum, item) => sum + item.bytes, 0),
      paths,
      running_apps: runningForCategory(category, runningProcesses),
      warning: category.warning,
      ...(category.overlaps.length ? { overlaps: category.overlaps } : {}),
      ...(category.scan_hint ? { scan_hint: category.scan_hint } : {}),
    };
  }).sort((a, b) => b.total_bytes - a.total_bytes);
}

function buildTargetPlan(categories, targetBytes, maxCategories = 12) {
  const target = Math.max(0, Number(targetBytes) || 0);
  if (!target) return null;
  const riskRank = { low: 0, medium: 1, high: 2 };
  const candidates = categories
    .filter(c => c.planning_eligible && c.total_bytes > 0)
    .sort((a, b) => (riskRank[a.risk] - riskRank[b.risk]) || (b.total_bytes - a.total_bytes));
  const steps = [];
  let potential = 0;
  let pipelinePotential = 0;
  for (const item of candidates) {
    if (steps.length >= maxCategories || potential >= target) break;
    steps.push({
      category: item.id,
      label: item.label,
      potential_bytes: item.total_bytes,
      risk: item.risk,
      cleanup_route: item.cleanup_route,
      reclaimable_via_pipeline: item.reclaimable_via_pipeline,
      out_of_pipeline: !item.reclaimable_via_pipeline,
      requires_review: true,
    });
    potential += item.total_bytes;
    if (item.reclaimable_via_pipeline) pipelinePotential += item.total_bytes;
  }
  let status = 'insufficient_known_candidates';
  if (pipelinePotential >= target) status = 'pipeline_potentially_met';
  else if (potential >= target) status = 'manual_or_out_of_pipeline_actions_required';
  return {
    target_bytes: target,
    potential_bytes: potential,
    pipeline_potential_bytes: pipelinePotential,
    out_of_pipeline_potential_bytes: potential - pipelinePotential,
    remaining_bytes: Math.max(0, target - potential),
    pipeline_remaining_bytes: Math.max(0, target - pipelinePotential),
    status,
    steps,
    note: 'Category sizes are upper-bound estimates, not pre-approved deletion amounts. Only steps marked reclaimable_via_pipeline can use the reversible cleanup pipeline; every step still requires item review.',
  };
}

module.exports = {
  MAINTENANCE_TOOLS,
  buildCatalog,
  parseDfKb,
  parseSnapshots,
  parseProcessList,
  buildCategoryReports,
  buildTargetPlan,
};

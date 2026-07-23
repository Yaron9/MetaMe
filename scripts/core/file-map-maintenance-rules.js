'use strict';

/**
 * Declarative maintenance rules shared by discovery, presentation and action
 * planning. This is an independent MetaMe model: rules describe intent and
 * capabilities, never shell fragments.
 */

const ARTIFACT_RULES = Object.freeze([
  {
    id: 'javascript-node-modules',
    names: ['node_modules'],
    markers: ['package.json'],
    markerLocation: 'parent',
    risk: 'medium',
    recoverability: 'regenerable',
    executionMode: 'report_only',
  },
  {
    id: 'rust-target',
    names: ['target'],
    markers: ['Cargo.toml'],
    markerLocation: 'parent',
    risk: 'low',
    recoverability: 'regenerable',
    executionMode: 'native_adapter',
    adapterId: 'cargo_clean',
  },
  {
    id: 'swift-build',
    names: ['.build'],
    markers: ['Package.swift'],
    markerLocation: 'parent',
    risk: 'low',
    recoverability: 'regenerable',
    executionMode: 'report_only',
  },
  {
    id: 'python-virtualenv',
    names: ['.venv', 'venv'],
    markers: ['pyvenv.cfg'],
    markerLocation: 'self',
    risk: 'medium',
    recoverability: 'regenerable',
    executionMode: 'report_only',
  },
  {
    id: 'generic-build-output',
    names: ['build', 'dist'],
    markers: ['package.json', 'pyproject.toml', 'Package.swift'],
    markerLocation: 'parent',
    risk: 'medium',
    recoverability: 'project_dependent',
    executionMode: 'report_only',
  },
]);

const INSTALLER_EXTENSIONS = Object.freeze(new Set(['.dmg', '.pkg', '.mpkg', '.iso', '.xip']));
const CACHE_CATEGORY_IDS = Object.freeze(new Set(['browser_caches', 'developer_tools']));
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

function artifactRuleFor(fsx, pathx, candidatePath) {
  const basename = pathx.basename(candidatePath);
  for (const rule of ARTIFACT_RULES) {
    if (!rule.names.includes(basename)) continue;
    const markerRoot = rule.markerLocation === 'self' ? candidatePath : pathx.dirname(candidatePath);
    if (rule.markers.some(marker => existsFile(fsx, pathx.join(markerRoot, marker)))) return rule;
  }
  if (hasValidCacheDirTag(fsx, pathx.join(candidatePath, 'CACHEDIR.TAG'))) {
    return {
      id: 'cachedir-tag',
      risk: 'medium',
      recoverability: 'regenerable',
      executionMode: 'report_only',
    };
  }
  return null;
}

function hasValidCacheDirTag(fsx, file) {
  try {
    const content = fsx.readFileSync(file);
    return content.subarray(0, CACHEDIR_SIGNATURE.length).toString('utf8') === CACHEDIR_SIGNATURE;
  } catch { return false; }
}

function installerRuleFor(pathx, candidatePath, zipEntries) {
  const extension = pathx.extname(candidatePath).toLowerCase();
  if (INSTALLER_EXTENSIONS.has(extension)) {
    return {
      id: `installer-${extension.slice(1)}`,
      risk: 'medium',
      recoverability: 'quarantine',
      executionMode: 'quarantine_file',
    };
  }
  if (extension !== '.zip' || !isInstallerZip(zipEntries)) return null;
  return {
    id: 'installer-zip',
    risk: 'medium',
    recoverability: 'quarantine',
    executionMode: 'quarantine_file',
  };
}

function isInstallerZip(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 50) return false;
  return entries.some(entry => {
    const clean = String(entry || '').replace(/^\.\//, '');
    return /(^|\/)[^/]+\.(?:app|pkg|mpkg)(?:\/|$)/i.test(clean);
  });
}

function cacheRulesFromCatalog(catalog) {
  const rules = [];
  for (const category of catalog || []) {
    if (!CACHE_CATEGORY_IDS.has(category.id)) continue;
    for (const cachePath of category.paths || []) {
      const isHomebrew = /\/Library\/Caches\/Homebrew$/.test(cachePath);
      rules.push({
        id: isHomebrew ? 'homebrew-cache' : `${category.id}:${cachePath}`,
        categoryId: category.id,
        path: cachePath,
        processes: category.processes || [],
        risk: category.risk,
        recoverability: category.recoverability,
        executionMode: isHomebrew ? 'native_adapter' : 'report_only',
        adapterId: isHomebrew ? 'brew_cleanup' : undefined,
        warning: category.warning,
      });
    }
  }
  return rules;
}

function existsFile(fsx, file) {
  try { return fsx.statSync(file).isFile(); } catch { return false; }
}

module.exports = {
  ARTIFACT_RULES,
  INSTALLER_EXTENSIONS,
  CACHE_CATEGORY_IDS,
  CACHEDIR_SIGNATURE,
  artifactRuleFor,
  installerRuleFor,
  isInstallerZip,
  cacheRulesFromCatalog,
  hasValidCacheDirTag,
};

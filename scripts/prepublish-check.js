'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { isTestScriptFile } = require('./deploy-manifest');

const CONFIG_FILES = [
  'scripts/daemon.yaml',
  'plugin/scripts/daemon.yaml',
];

const SECRET_KEYS = new Set([
  'bot_token',
  'app_secret',
  'access_token',
  'refresh_token',
  'api_key',
  'api_secret',
  'secret',
]);

const PLACEHOLDER_RE = /^(null|undefined|false|0|changeme|change_me|placeholder|your[_-]?.*|<.*>|\$\{.*\})$/i;
const FORBIDDEN_PACKAGE_RULES = [
  { check: file => /^scripts\/hooks\/test-.*\.js$/.test(file), reason: 'test hook' },
  { check: file => /(^|\/)test-support\//.test(file), reason: 'test support directory' },
  { check: file => /(^|\/)test-utils\.js$/.test(file), reason: 'test utility' },
  { check: file => /(^|\/)test-env-setup\.js$/.test(file), reason: 'old test env setup' },
  { check: file => /(^|\/)test_daemon\.js$/.test(file), reason: 'legacy test daemon' },
  { check: file => isTestScriptFile(path.basename(file)), reason: 'test script' },
  { check: file => /(^|\/)daemon\.yaml$/.test(file), reason: 'user config file' },
  { check: file => /(^|\/)daemon\.yaml\.bak$/.test(file), reason: 'user config backup' },
  { check: file => /(^|\/)memory-migrate-v2\.js$/.test(file), reason: 'obsolete destructive migration' },
  { check: file => /(^|\/)verify-reactive-claude-md\.js$/.test(file), reason: 'obsolete verifier' },
  { check: file => /(^|\/)\.DS_Store$/.test(file), reason: 'macOS metadata' },
];

function isRealSecretValue(value) {
  if (value == null || value === false) return false;
  const text = String(value).trim();
  if (!text) return false;
  if (PLACEHOLDER_RE.test(text)) return false;
  return true;
}

function collectSecretPaths(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEYS.has(key) && isRealSecretValue(child)) {
      out.push(childPath);
      continue;
    }
    if (child && typeof child === 'object') out.push(...collectSecretPaths(child, childPath));
  }
  return out;
}

function inspectConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const parsed = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
  return collectSecretPaths(parsed);
}

function inspectPackageFileList(files) {
  const violations = [];
  for (const file of files || []) {
    for (const rule of FORBIDDEN_PACKAGE_RULES) {
      if (rule.check(file)) {
        violations.push(`${file}: ${rule.reason}`);
        break;
      }
    }
  }
  return violations;
}

function collectPackageFileList(root) {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const data = JSON.parse(raw);
  return (data[0] && data[0].files ? data[0].files : []).map(item => item.path).sort();
}

function resolveProjectRoot() {
  const directRoot = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(directRoot, 'package.json'))) return directRoot;
  const pluginRoot = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(pluginRoot, 'package.json'))) return pluginRoot;
  return directRoot;
}

function main() {
  const root = resolveProjectRoot();
  const failures = [];
  for (const rel of CONFIG_FILES) {
    const secretPaths = inspectConfigFile(path.join(root, rel));
    if (secretPaths.length) failures.push(`${rel}: ${secretPaths.join(', ')}`);
  }
  const packageViolations = inspectPackageFileList(collectPackageFileList(root));
  for (const violation of packageViolations) failures.push(`package: ${violation}`);
  if (failures.length) {
    console.error(`ABORT: publish safety check failed:\n${failures.join('\n')}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  isRealSecretValue,
  collectSecretPaths,
  inspectConfigFile,
  inspectPackageFileList,
  collectPackageFileList,
  resolveProjectRoot,
};

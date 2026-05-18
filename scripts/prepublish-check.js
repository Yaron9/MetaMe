'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

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
  if (failures.length) {
    console.error(`ABORT: Real credentials found before publish:\n${failures.join('\n')}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { isRealSecretValue, collectSecretPaths, inspectConfigFile, resolveProjectRoot };

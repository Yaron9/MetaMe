'use strict';

const os = require('os');
const path = require('path');

const RUNTIME_WIKI_RELATIVE_PATH = path.join('.metame', 'wiki');

function expandHomePath(input, home = os.homedir()) {
  if (!input) return input;
  return String(input).replace(/^~(?=$|[\\/])/, home);
}

function defaultWikiOutputDir(home = os.homedir()) {
  return path.join(home, RUNTIME_WIKI_RELATIVE_PATH);
}

function resolveWikiOutputDir(outputDir, { home = os.homedir() } = {}) {
  if (!outputDir) return defaultWikiOutputDir(home);
  return path.resolve(expandHomePath(outputDir, home));
}

function resolveConfiguredWikiOutputDir(config, { home = os.homedir() } = {}) {
  return resolveWikiOutputDir(config && config.daemon && config.daemon.wiki_output_dir, { home });
}

module.exports = {
  RUNTIME_WIKI_RELATIVE_PATH,
  defaultWikiOutputDir,
  expandHomePath,
  resolveConfiguredWikiOutputDir,
  resolveWikiOutputDir,
};

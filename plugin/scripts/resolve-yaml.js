'use strict';

const path = require('path');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  const metameRoot = process.env.METAME_ROOT;
  if (metameRoot) {
    try { yaml = require(path.join(metameRoot, 'node_modules', 'js-yaml')); } catch {}
  }
  if (!yaml) {
    const candidates = [
      path.resolve(__dirname, '..', 'node_modules', 'js-yaml'),
      path.resolve(__dirname, 'node_modules', 'js-yaml'),
    ];
    for (const p of candidates) {
      try { yaml = require(p); break; } catch {}
    }
  }
}

module.exports = yaml;

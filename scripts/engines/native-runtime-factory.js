'use strict';

// Engine Plugin adapter assembly is the only place where native Runtime
// Adapter implementations are imported together.  Shared routing and
// analytics consume the immutable plugin returned by this boundary instead
// of reaching into adapter internals.
const { _private: claudeAdapter } = require('./claude-cli-adapter');
const { _private: codexAdapter } = require('./codex-cli-adapter');
const { _private: agyAdapter } = require('./agy-cli-adapter');
const { _private: piAdapter } = require('./pi-cli-adapter');

module.exports = Object.freeze({
  claudeAdapter,
  codexAdapter,
  agyAdapter,
  piAdapter,
});


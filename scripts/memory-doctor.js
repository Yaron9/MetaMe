#!/usr/bin/env node

'use strict';

const { runMemoryCommand } = require('./memory-observability');

function main(argv = process.argv.slice(2), options = {}) {
  return runMemoryCommand('doctor', argv, options);
}

if (require.main === module) main();

module.exports = { main };

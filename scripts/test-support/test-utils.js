'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function testTmpRoot() {
  const tmp = path.resolve(os.tmpdir());
  return tmp === process.cwd() ? '/tmp' : tmp;
}

function mkdtempForTest(prefix) {
  return fs.mkdtempSync(path.join(testTmpRoot(), prefix));
}

module.exports = {
  mkdtempForTest,
  testTmpRoot,
};

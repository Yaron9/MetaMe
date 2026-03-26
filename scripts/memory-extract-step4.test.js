'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const memExtract = require('./memory-extract');

describe('memory-extract dead code removal', () => {
  it('no longer exports _private helpers for fact_labels', () => {
    assert.equal(memExtract._private, undefined);
  });

  it('still exports run and extractFacts', () => {
    assert.equal(typeof memExtract.run, 'function');
    assert.equal(typeof memExtract.extractFacts, 'function');
  });
});

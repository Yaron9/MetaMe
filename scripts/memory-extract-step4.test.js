'use strict';

require('./test-support/env-setup');
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

  it('rejects relations outside the durable memory taxonomy', () => {
    const base = {
      entity: 'MetaMe.memory',
      value: '这是一条具有充分上下文、可以独立理解并值得长期保存的事实记录。',
      confidence: 'high',
      tags: ['memory'],
    };
    assert.equal(memExtract._internal.isValidExtractedFact({ ...base, relation: 'arch_convention' }), true);
    assert.equal(memExtract._internal.isValidExtractedFact({ ...base, relation: 'current_problem' }), false);
  });
});

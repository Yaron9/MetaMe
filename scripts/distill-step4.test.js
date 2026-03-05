'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const distill = require('./distill');

describe('distill Step4 competence merge', () => {
  it('upgrades level but blocks downgrade without explicit evidence', () => {
    const current = { nodejs: 'intermediate', sql: 'expert' };
    const signals = [
      { domain: 'nodejs', level: 'expert', evidence: 'can explain event loop deeply' },
      { domain: 'sql', level: 'beginner', evidence: 'asked a basic question' },
    ];
    const res = distill._private.mergeCompetenceMap(current, signals);
    assert.equal(res.map.nodejs, 'expert');
    assert.equal(res.map.sql, 'expert');
    assert.equal(res.changed, true);
  });

  it('allows downgrade only with downgrade_evidence', () => {
    const current = { docker: 'expert' };
    const signals = [
      {
        domain: 'docker',
        level: 'intermediate',
        evidence: 'recent mistakes',
        downgrade_evidence: '连续三次关键命令混淆',
      },
    ];
    const res = distill._private.mergeCompetenceMap(current, signals);
    assert.equal(res.map.docker, 'intermediate');
    assert.equal(res.changed, true);
  });
});

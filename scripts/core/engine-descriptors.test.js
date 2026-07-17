'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENGINE_DESCRIPTORS, ENGINE_NAMES, getEngineDescriptor } = require('./engine-descriptors');

const PROJECTIONS = ['claude-import', 'agents-md-merge', 'prompt-bootstrap'];

test('every engine declares a complete, valid descriptor', () => {
  assert.ok(ENGINE_NAMES.length >= 3);
  for (const name of ENGINE_NAMES) {
    const d = ENGINE_DESCRIPTORS[name];
    assert.equal(d.name, name);
    assert.ok(d.provider, `${name} missing provider`);
    assert.ok(PROJECTIONS.includes(d.contextProjection), `${name} has unknown contextProjection: ${d.contextProjection}`);
    assert.ok(d.sessionStorage, `${name} missing sessionStorage`);
    assert.ok(Object.prototype.hasOwnProperty.call(d, 'hostHook'), `${name} must declare hostHook (null allowed)`);
  }
});

test('daemon-utils engine identity derives from the descriptor registry', () => {
  const { ENGINE_NAMES: utilNames, normalizeEngineName } = require('../daemon-utils');
  assert.deepEqual([...utilNames], [...ENGINE_NAMES]);
  for (const name of ENGINE_NAMES) assert.equal(normalizeEngineName(name), name);
  assert.equal(normalizeEngineName('unknown-engine'), 'claude');
});

test('getEngineDescriptor normalizes case and rejects unknowns', () => {
  assert.equal(getEngineDescriptor('CLAUDE'), ENGINE_DESCRIPTORS.claude);
  assert.equal(getEngineDescriptor(' codex '), ENGINE_DESCRIPTORS.codex);
  assert.equal(getEngineDescriptor('gpt-x'), null);
  assert.equal(getEngineDescriptor(null), null);
});

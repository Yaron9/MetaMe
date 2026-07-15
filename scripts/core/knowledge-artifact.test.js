'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCanonicalKey,
  parseArtifactMarkdown,
  serializeArtifact,
  stableArtifactId,
  validateArtifact,
} = require('./knowledge-artifact');

const BASE = {
  kind: 'playbook', title: 'Deploy', canonical_key: 'MetaMe / Deploy', project_key: 'MetaMe',
  status: 'active', revision: 1, evidence_ids: ['mi_2', 'mi_1', 'mi_1'],
  created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
  generator_version: 'artifact-v1',
};

test('canonical identity is deterministic and separator-normalized', () => {
  assert.equal(normalizeCanonicalKey(' MetaMe _ Deploy '), 'metame-deploy');
  assert.equal(stableArtifactId('playbook', 'metame/deploy'), stableArtifactId('playbook', 'metame/deploy'));
});

test('artifact serialization is canonical and self-validating', () => {
  const markdown = serializeArtifact(BASE, '# Deploy\r\n\n- verify');
  const artifact = parseArtifactMarkdown(markdown);
  assert.deepEqual(artifact.meta.evidence_ids, ['mi_1', 'mi_2']);
  assert.equal(validateArtifact(artifact).ok, true);
  assert.equal(serializeArtifact(artifact.meta, artifact.body), markdown);
});

test('active artifact without evidence and edited managed content fail closed', () => {
  const noEvidence = parseArtifactMarkdown(serializeArtifact({ ...BASE, evidence_ids: [] }, '# Empty'));
  assert.match(validateArtifact(noEvidence).errors.join(','), /requires evidence/);
  const edited = { ...parseArtifactMarkdown(serializeArtifact(BASE, '# Original')), body: '# Edited\n' };
  assert.match(validateArtifact(edited).errors.join(','), /content_hash mismatch/);
});

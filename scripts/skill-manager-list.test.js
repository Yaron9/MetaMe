'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { mkdtempForTest } = require('./test-support/test-utils');

const LIST_SKILLS = path.join(
  __dirname,
  '..',
  'skills',
  'skill-manager',
  'scripts',
  'list_skills.py',
);

function renderSkill(frontmatter) {
  const root = mkdtempForTest('metame-list-skills-');
  const skillDir = path.join(root, 'example-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\n${frontmatter}---\n\n# Example\n`,
    'utf8',
  );
  return execFileSync('python3', [LIST_SKILLS, root], { encoding: 'utf8' });
}

describe('skill-manager list_skills.py', () => {
  it('reports a missing version as unknown instead of inventing 0.1.0', () => {
    const output = renderSkill(
      'name: example-skill\n'
      + 'description: Example skill.\n',
    );

    assert.match(output, /example-skill/);
    assert.match(output, /—/);
    assert.doesNotMatch(output, /0\.1\.0/);
  });

  it('reads an explicitly declared metadata version', () => {
    const output = renderSkill(
      'name: example-skill\n'
      + 'description: Example skill.\n'
      + 'metadata:\n'
      + '  version: 2.3.4\n',
    );

    assert.match(output, /2\.3\.4/);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  migrateLegacySelfReflectionPatterns,
  normalizeSelfReflectionPatterns,
} = require('./self-reflect');

test('migrateLegacySelfReflectionPatterns moves legacy strings and preserves user observation objects', () => {
  const profile = {
    growth: {
      patterns: [
        '倾向先行动再讨论',
        { type: 'growth', summary: '开始先确认范围', confidence: 0.9, surfaced: null },
      ],
      self_reflection_patterns: [
        { summary: '代码审查不够全面', detected: '2026-03-10' },
      ],
    },
  };

  const result = migrateLegacySelfReflectionPatterns(profile);

  assert.equal(result.changed, true);
  assert.deepEqual(profile.growth.patterns, [
    { type: 'growth', summary: '开始先确认范围', confidence: 0.9, surfaced: null },
  ]);
  assert.deepEqual(profile.growth.self_reflection_patterns, [
    { summary: '倾向先行动再讨论', detected: profile.growth.self_reflection_patterns[0].detected },
    { summary: '代码审查不够全面', detected: '2026-03-10' },
  ]);
});

test('normalizeSelfReflectionPatterns deduplicates mixed legacy and new reflection entries', () => {
  const profile = {
    growth: {
      patterns: ['倾向先行动再讨论', '倾向先行动再讨论'],
      self_reflection_patterns: [
        { summary: '倾向先行动再讨论', detected: '2026-03-10' },
        { summary: '代码审查不够全面', detected: '2026-03-11' },
      ],
    },
  };

  const normalized = normalizeSelfReflectionPatterns(profile);

  assert.equal(normalized.length, 2);
  assert.deepEqual(
    normalized.map(p => p.summary),
    ['倾向先行动再讨论', '代码审查不够全面'],
  );
  assert.deepEqual(profile.growth.patterns, []);
});

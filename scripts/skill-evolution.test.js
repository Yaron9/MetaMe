const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metame-skill-evo-'));
}

function runWithHome(home, code) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

test('captures missing-skill failures into skill_gap queue', () => {
  const home = mkHome();
  runWithHome(home, `
    const se = require('./scripts/skill-evolution');
    const s = se.extractSkillSignal('帮我做封面图', 'Error: skill not found: nano-banana', null, [], process.cwd(), []);
    se.appendSkillSignal(s);
    se.checkHotEvolution(s);
  `);

  const queuePath = path.join(home, '.metame', 'evolution_queue.yaml');
  const queue = yaml.load(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(Array.isArray(queue.items), true);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].type, 'skill_gap');
  assert.equal(queue.items[0].status, 'pending');
  assert.ok(queue.items[0].id);
});

test('resolves queue item by id', () => {
  const home = mkHome();
  runWithHome(home, `
    const se = require('./scripts/skill-evolution');
    const s = se.extractSkillSignal('帮我做封面图', 'Error: skill not found: nano-banana', null, [], process.cwd(), []);
    se.appendSkillSignal(s);
    se.checkHotEvolution(s);
    const items = se.listQueueItems({ status: 'pending', limit: 5 });
    if (!items[0]) throw new Error('no pending queue item');
    const ok = se.resolveQueueItemById(items[0].id, 'installed');
    if (!ok) throw new Error('resolveQueueItemById returned false');
  `);

  const queuePath = path.join(home, '.metame', 'evolution_queue.yaml');
  const queue = yaml.load(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].status, 'installed');
});

test('smartStitch preserves sections after evolution block', () => {
  const home = mkHome();
  runWithHome(home, `
    const fs = require('fs');
    const path = require('path');
    const se = require('./scripts/skill-evolution');
    const dir = path.join(process.env.HOME, 'sample-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Demo\\n\\nBody\\n\\n## User-Learned Best Practices & Constraints\\nOld\\n\\n## KeepMe\\nKeep this section\\n');
    fs.writeFileSync(path.join(dir, 'evolution.json'), JSON.stringify({ preferences: ['prefer concise output'] }, null, 2));
    se.smartStitch(dir);
  `);

  const content = fs.readFileSync(path.join(home, 'sample-skill', 'SKILL.md'), 'utf8');
  assert.match(content, /METAME-EVOLUTION:START/);
  assert.match(content, /prefer concise output/);
  assert.match(content, /## KeepMe/);
  assert.match(content, /Keep this section/);
});

test('trackInsightOutcome updates only matched insights', () => {
  const home = mkHome();
  runWithHome(home, `
    const fs = require('fs');
    const path = require('path');
    const se = require('./scripts/skill-evolution');
    const dir = path.join(process.env.HOME, '.claude', 'skills', 'demo-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Demo');
    fs.writeFileSync(path.join(dir, 'evolution.json'), JSON.stringify({
      preferences: ['alpha_mode'],
      fixes: ['beta_mode']
    }, null, 2));
    se.trackInsightOutcome(dir, true, {
      prompt: 'please use alpha_mode',
      error: '',
      output_excerpt: '',
      tools_used: [],
      files_modified: []
    });
  `);

  const evo = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'skills', 'demo-skill', 'evolution.json'), 'utf8'));
  assert.equal(typeof evo.insights_stats, 'object');
  assert.ok(evo.insights_stats.alpha_mode);
  assert.equal(evo.insights_stats.alpha_mode.success_count, 1);
  assert.equal(evo.insights_stats.beta_mode, undefined);
});

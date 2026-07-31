'use strict';

require('./test-support/env-setup');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  nextMinute,
  setup,
} = require('./research-radar-setup');

describe('research radar task setup', () => {
  let tempDir;
  let configPath;
  let stateDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-setup-'));
    configPath = path.join(tempDir, 'daemon.yaml');
    stateDir = path.join(tempDir, 'state');
    fs.writeFileSync(configPath, yaml.dump({
      feishu: {
        allowed_chat_ids: ['chat-scientist'],
        chat_agent_map: { 'chat-scientist': 'scientist' },
      },
      projects: {
        scientist: {
          name: '科研总监',
          cwd: '~/AGI/AgentScientist',
          heartbeat_tasks: [],
        },
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBaselineMarker() {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'live-baseline-pass.json'), JSON.stringify({
      passed: true,
      mode: 'baseline-no-delivery',
    }));
  }

  function writeReceipt() {
    const receiptDir = path.join(stateDir, 'delivery-receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, 'first.json'), JSON.stringify({
      deliveryStatus: 'success',
      deliveredAt: '2026-07-31T13:00:00.000Z',
      payload: { scanStatus: 'success' },
    }));
  }

  it('installs both tasks disabled for scheduling and targets only Feishu', () => {
    const result = setup({
      mode: 'install',
      configPath,
      stateDir,
      now: new Date('2026-07-31T13:00:00.000Z'),
    });
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const project = config.projects.scientist;

    assert.equal(result.tasks['research-radar-daily'].scheduleEnabled, false);
    assert.equal(result.tasks['research-radar-first-report'].scheduleEnabled, false);
    assert.equal(project.notification_channel, 'feishu');
    assert.equal(project.strict_notify_target, true);
    assert.equal(project.heartbeat_tasks.length, 2);
    assert.equal(
      project.heartbeat_tasks.find(item => item.name === 'research-radar-first-report').one_shot,
      true,
    );
  });

  it('stages one first report only after baseline and activates daily only after receipt', () => {
    writeBaselineMarker();
    const staged = setup({
      mode: 'stage-first',
      configPath,
      stateDir,
      now: new Date('2026-07-31T13:00:00.000Z'),
    });
    assert.equal(staged.tasks['research-radar-first-report'].scheduleEnabled, true);
    assert.equal(staged.tasks['research-radar-first-report'].at, '21:02');
    assert.equal(staged.tasks['research-radar-daily'].scheduleEnabled, false);

    assert.throws(() => setup({
      mode: 'activate',
      configPath,
      stateDir,
    }), /receipt/);
    writeReceipt();
    const activated = setup({
      mode: 'activate',
      configPath,
      stateDir,
    });
    assert.equal(activated.tasks['research-radar-first-report'].scheduleEnabled, false);
    assert.equal(activated.tasks['research-radar-daily'].scheduleEnabled, true);
  });

  it('rolls back scheduling without deleting state', () => {
    const result = setup({ mode: 'rollback', configPath, stateDir });
    assert.equal(result.tasks['research-radar-daily'].scheduleEnabled, false);
    assert.equal(result.tasks['research-radar-first-report'].scheduleEnabled, false);
    assert.equal(fs.existsSync(configPath), true);
  });

  it('computes the first-report slot in local time', () => {
    assert.equal(nextMinute(new Date(2026, 6, 31, 23, 59), 2), '00:01');
  });
});

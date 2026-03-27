'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  VALID_TEAM_COLORS,
  parseTeamMembers,
  createTeamWorkspace,
} = require('./daemon-team-workflow');

describe('daemon-team-workflow', () => {
  it('parses team members and normalizes fallback colors', () => {
    const members = parseTeamMembers('编剧:✍️:green, 审核:🔍:invalid\n推广', '短剧团队');

    assert.equal(members.length, 3);
    assert.deepEqual(members[0], {
      key: '编剧',
      name: '短剧团队 · 编剧',
      icon: '✍️',
      color: 'green',
      nicknames: ['编剧'],
    });
    assert.equal(members[1].color, VALID_TEAM_COLORS[1]);
    assert.equal(members[2].icon, '🤖');
    assert.equal(members[2].color, VALID_TEAM_COLORS[2]);
  });

  it('creates member workspaces and registers the team under the parent project', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-team-'));
    const dirPath = path.join(rootDir, 'workspace');
    fs.mkdirSync(dirPath, { recursive: true });

    const cfg = {
      projects: {
        metame: {
          cwd: dirPath,
        },
      },
    };
    const writes = [];
    let backups = 0;
    const members = parseTeamMembers('甲:🅰️:blue,乙:🅱️:red', '研发组');

    const result = createTeamWorkspace({
      fs,
      path,
      execSync: () => {},
      dirPath,
      teamName: '研发组',
      members,
      loadConfig: () => cfg,
      normalizeCwd: (value) => path.resolve(String(value || '')),
      writeConfigSafe: (nextCfg) => writes.push(nextCfg.projects.metame.team.length),
      backupConfig: () => { backups += 1; },
      HOME: os.homedir(),
    });

    assert.equal(result.parentProjectKey, 'metame');
    assert.equal(result.teamDir, path.join(dirPath, 'team'));
    assert.equal(result.memberLines.length, 2);
    assert.equal(cfg.projects.metame.team.length, 2);
    assert.equal(cfg.projects.metame.team[0].cwd, path.join(dirPath, 'team', '甲'));
    assert.ok(fs.existsSync(path.join(dirPath, 'team', '甲', 'CLAUDE.md')));
    assert.deepEqual(writes, [2]);
    assert.equal(backups, 1);
  });
});

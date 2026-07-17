'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SKILL_ROUTES, routeSkill, findUnknownRouteTargets } = require('./daemon-skill-routes');

describe('daemon-skill-routes', () => {
  it('every route targets a skill that ships in this repo', () => {
    const shipped = fs.readdirSync(path.join(__dirname, '..', 'skills'), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    assert.deepEqual(findUnknownRouteTargets(shipped), [], 'routes must not point at nonexistent skills');
  });

  it('routes mail/calendar asks', () => {
    assert.equal(routeSkill('看下我的收件箱有没有新邮件'), 'macos-mail-calendar');
    assert.equal(routeSkill('明天的日程是什么'), 'macos-mail-calendar');
  });

  it('routes macOS automation only with an explicit action', () => {
    assert.equal(routeSkill('用 applescript 打开 Safari'), 'macos-local-orchestrator');
    assert.equal(routeSkill('帮我锁屏'), 'macos-local-orchestrator');
    assert.equal(routeSkill('macos 是什么系统'), null, 'mentioning macOS alone must not route');
  });

  it('routes reminders and recurring asks', () => {
    assert.equal(routeSkill('每天 8 点提醒我喝水'), 'heartbeat-task-manager');
    assert.equal(routeSkill('remind me at 6pm'), 'heartbeat-task-manager');
  });

  it('routes skill discovery and evolution', () => {
    assert.equal(routeSkill('帮我找技能处理 PDF'), 'skill-manager');
    assert.equal(routeSkill('复盘一下这次任务，保存到 skill'), 'skill-creator');
    assert.equal(routeSkill('/evolve 这次的经验'), 'skill-creator');
  });

  it('routes file delivery but not forwarding', () => {
    assert.equal(routeSkill('把日志文件发我'), 'send-to-user');
    assert.equal(routeSkill('发个 pdf 到手机'), 'send-to-user');
    assert.equal(routeSkill('把这条消息转发给我'), null, '转发 is conversation relay, not file delivery');
  });

  it('returns null for ordinary conversation', () => {
    assert.equal(routeSkill('今天天气怎么样'), null);
    assert.equal(routeSkill(''), null);
  });

  it('route table shape is stable', () => {
    for (const route of SKILL_ROUTES) {
      assert.ok(route.name, 'route needs a name');
      assert.ok(route.pattern instanceof RegExp || typeof route.match === 'function', `${route.name} needs pattern or match`);
    }
  });
});

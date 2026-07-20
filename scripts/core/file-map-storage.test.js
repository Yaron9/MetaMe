'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('./file-map-storage');

describe('file-map-storage parsers', () => {
  it('parses macOS and Linux df -k output', () => {
    const mac = storage.parseDfKb(
      'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s1 1000 600 400 60% 1 2 33% /System/Volumes/Data\n'
    );
    assert.equal(mac.total_bytes, 1000 * 1024);
    assert.equal(mac.available_bytes, 400 * 1024);
    assert.equal(mac.mount, '/System/Volumes/Data');

    const linux = storage.parseDfKb(
      'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/x 2000 500 1500 25% /\n'
    );
    assert.equal(linux.used_bytes, 500 * 1024);
    assert.equal(linux.mount, '/');
    assert.equal(storage.parseDfKb('broken'), null);
  });

  it('parses snapshots and running process names', () => {
    assert.deepEqual(storage.parseSnapshots(
      'Snapshots for volume group containing disk /:\ncom.apple.TimeMachine.2026-07-18.local\ncom.apple.os.update-ABC\n'
    ), {
      count: 2,
      time_machine_count: 1,
      os_update_count: 1,
      items: ['com.apple.TimeMachine.2026-07-18.local', 'com.apple.os.update-ABC'],
      truncated: undefined,
    });
    assert.deepEqual(storage.parseProcessList('/Applications/Safari.app/Safari\n/usr/bin/node\n'), [
      '/applications/safari.app/safari', '/usr/bin/node',
    ]);
  });
});

describe('file-map-storage categories + planning', () => {
  it('expands home paths, adds protection and reports running apps', () => {
    const catalog = storage.buildCatalog('/home/u');
    const safari = '/home/u/Library/Caches/com.apple.Safari';
    const reports = storage.buildCategoryReports(catalog, new Map([[safari, 2048]]), {
      protectedMatch: p => p.includes('/Library/'),
      runningProcesses: ['/applications/safari.app/contents/macos/safari', '/usr/local/bin/email-helper'],
    });
    const browsers = reports.find(r => r.id === 'browser_caches');
    assert.equal(browsers.total_bytes, 2 * 1024 * 1024);
    assert.equal(browsers.paths[0].protected, true);
    assert.deepEqual(browsers.running_apps, ['Safari']);
    assert.deepEqual(reports.find(r => r.id === 'mail_messages').running_apps, [], 'mail does not substring-match email-helper');
    const aggregate = reports.find(r => r.id === 'application_caches');
    assert.deepEqual(aggregate.overlaps, ['browser_caches', 'developer_tools']);
  });

  it('builds a low-risk-first target plan and never treats it as approval', () => {
    const categories = [
      { id: 'media', label: 'Media', risk: 'high', planning_eligible: true, reclaimable_via_pipeline: false, total_bytes: 9 },
      { id: 'trash', label: 'Trash', risk: 'low', planning_eligible: true, reclaimable_via_pipeline: false, total_bytes: 4 },
      { id: 'aggregate', label: 'Aggregate', risk: 'low', planning_eligible: false, reclaimable_via_pipeline: false, total_bytes: 100 },
      { id: 'cache', label: 'Cache', risk: 'medium', planning_eligible: true, reclaimable_via_pipeline: true, total_bytes: 6 },
    ].map(c => ({ ...c, cleanup_route: 'review' }));
    const plan = storage.buildTargetPlan(categories, 8);
    assert.equal(plan.status, 'manual_or_out_of_pipeline_actions_required');
    assert.equal(plan.pipeline_potential_bytes, 6);
    assert.deepEqual(plan.steps.map(s => s.category), ['trash', 'cache']);
    assert.ok(plan.steps.every(s => s.requires_review));
    assert.equal(plan.steps[0].out_of_pipeline, true);
    assert.equal(plan.steps[1].reclaimable_via_pipeline, true);
    assert.equal(storage.buildTargetPlan(categories, 0), null);
  });
});

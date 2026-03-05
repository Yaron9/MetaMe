'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempHome(run) {
  const prevHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-acl-'));
  process.env.HOME = tempHome;
  try {
    const modPath = require.resolve('./daemon-user-acl');
    delete require.cache[modPath];
    const acl = require('./daemon-user-acl');
    return run({ acl, tempHome });
  } finally {
    process.env.HOME = prevHome;
    const modPath = require.resolve('./daemon-user-acl');
    delete require.cache[modPath];
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

test('bootstrap mode grants admin before users are configured', () => {
  withTempHome(({ acl }) => {
    const ctx = acl.resolveUserCtx('ou_bootstrap001', {});
    assert.equal(ctx.role, 'admin');
    assert.equal(ctx.readOnly, false);
    assert.equal(ctx.can('system'), true);

    const stranger = acl.resolveUserCtx('ou_other_user02', {});
    assert.equal(stranger.role, 'stranger');
    assert.equal(stranger.readOnly, true);
    assert.equal(stranger.can('query'), true);
    assert.equal(stranger.can('system'), false);
  });
});

test('default stranger keeps query permission after ACL is configured', () => {
  withTempHome(({ acl }) => {
    acl.saveUsers({
      default_role: 'stranger',
      users: {
        ou_admin0001: { role: 'admin', name: 'admin' },
      },
    });
    const ctx = acl.resolveUserCtx('ou_unknown_01', {});
    assert.equal(ctx.role, 'stranger');
    assert.equal(ctx.readOnly, true);
    assert.equal(ctx.can('query'), true);
    assert.equal(ctx.can('system'), false);
  });
});

test('/user add parsing stores uid/role/name correctly', () => {
  withTempHome(({ acl }) => {
    const adminCtx = acl.resolveUserCtx('ou_admin_12345', {});
    const out = acl.handleUserCommand('/user add ou_member_123 member Alice', adminCtx);
    assert.equal(out.handled, true);
    assert.match(out.reply, /已添加用户/);

    const users = acl.loadUsers();
    assert.equal(users.users.ou_member_123.role, 'member');
    assert.equal(users.users.ou_member_123.name, 'Alice');
  });
});

test('/user role/grant/revoke/remove parsing works', () => {
  withTempHome(({ acl }) => {
    const adminCtx = acl.resolveUserCtx('ou_admin_12345', {});
    acl.handleUserCommand('/user add ou_member_456 member Bob', adminCtx);

    const roleRes = acl.handleUserCommand('/user role ou_member_456 stranger', adminCtx);
    assert.equal(roleRes.handled, true);
    assert.equal(acl.loadUsers().users.ou_member_456.role, 'stranger');

    const grantRes = acl.handleUserCommand('/user grant ou_member_456 status', adminCtx);
    assert.equal(grantRes.handled, true);
    assert.deepEqual(acl.loadUsers().users.ou_member_456.allowed_actions, ['status']);

    const revokeRes = acl.handleUserCommand('/user revoke ou_member_456 status', adminCtx);
    assert.equal(revokeRes.handled, true);
    assert.deepEqual(acl.loadUsers().users.ou_member_456.allowed_actions, []);

    const rmRes = acl.handleUserCommand('/user remove ou_member_456', adminCtx);
    assert.equal(rmRes.handled, true);
    assert.equal(acl.loadUsers().users.ou_member_456, undefined);
  });
});

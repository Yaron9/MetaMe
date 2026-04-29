'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecretsAndPii } = require('./recall-redact');

test('recall-redact', async (t) => {
  await t.test('returns empty for non-string or empty', () => {
    assert.equal(redactSecretsAndPii(undefined), '');
    assert.equal(redactSecretsAndPii(null), '');
    assert.equal(redactSecretsAndPii(123), '');
    assert.equal(redactSecretsAndPii(''), '');
  });

  await t.test('redacts email', () => {
    const out = redactSecretsAndPii('contact yaron@live.com today');
    assert.match(out, /<email>/);
    assert.doesNotMatch(out, /yaron@live\.com/);
  });

  await t.test('redacts CN-style phone', () => {
    const out = redactSecretsAndPii('call +86 135-1234-5678 now');
    assert.match(out, /<phone>/);
    assert.doesNotMatch(out, /1234-5678/);
  });

  await t.test('redacts JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecretsAndPii(jwt);
    assert.match(out, /<jwt>/);
    assert.doesNotMatch(out, /eyJ/);
  });

  await t.test('drops URL query string', () => {
    const out = redactSecretsAndPii('GET /api/users?token=abc&id=42');
    assert.doesNotMatch(out, /token=/);
    assert.doesNotMatch(out, /\?/);
    assert.match(out, /\/api\/users/);
  });

  await t.test('redacts named secret kv (bot_token=)', () => {
    const out = redactSecretsAndPii('bot_token=xyzABC123 env');
    assert.match(out, /<secret>/);
    assert.doesNotMatch(out, /xyzABC123/);
  });

  await t.test('redacts MetaMe operator_id and chat_id', () => {
    const out = redactSecretsAndPii('operator_id:ou_f873edab380d4836f93cc9e9b9104f5a context');
    assert.match(out, /<secret>/);
    assert.doesNotMatch(out, /f873edab/);
  });

  await t.test('redacts long hex blob (sha256-like)', () => {
    const sha = 'deadbeefcafe1234567890abcdef1234567890abcdef1234567890abcdef1234';
    const out = redactSecretsAndPii('hash ' + sha);
    assert.match(out, /<hex>/);
  });

  await t.test('redacts long base64 blob', () => {
    const b64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=';
    const out = redactSecretsAndPii('blob ' + b64);
    assert.match(out, /<b64>/);
  });

  await t.test('collapses long path with ellipsis', () => {
    const longPath = '/Users/yaron/AGI/MetaMe/scripts/very/deep/nested/path/with/many/components/and/file.js';
    const out = redactSecretsAndPii(longPath);
    assert.ok(out.length <= 64);
    assert.match(out, /…/);
  });

  await t.test('truncates to 64 chars max', () => {
    const out = redactSecretsAndPii('a'.repeat(200));
    assert.ok(out.length <= 64);
  });

  await t.test('preserves short safe label as-is', () => {
    assert.equal(redactSecretsAndPii('file:scripts/memory.js'), 'file:scripts/memory.js');
    assert.equal(redactSecretsAndPii('fn:saveFacts'), 'fn:saveFacts');
    assert.equal(redactSecretsAndPii('errcode:ENOENT'), 'errcode:ENOENT');
  });

  await t.test('preserves Chinese text', () => {
    assert.equal(redactSecretsAndPii('上次的决策'), '上次的决策');
    assert.equal(redactSecretsAndPii('记得吗那个 bug'), '记得吗那个 bug');
  });

  await t.test('redacts standalone bot_secret_*', () => {
    const out = redactSecretsAndPii('config bot_secret_xyzABC123def env');
    assert.match(out, /<metame>/);
    assert.doesNotMatch(out, /xyzABC123def/);
  });

  await t.test('redacts standalone chat_ou_* and chat_oc_*', () => {
    const out1 = redactSecretsAndPii('chat chat_ou_abcDEF12345 reference');
    assert.match(out1, /<metame>/);
    assert.doesNotMatch(out1, /abcDEF12345/);

    const out2 = redactSecretsAndPii('group chat_oc_xyz98765 hello');
    assert.match(out2, /<metame>/);
  });

  await t.test('redacts standalone Feishu open ID (ou_*/oc_*)', () => {
    const out = redactSecretsAndPii('user ou_f873edab380d4836f93cc9e9b9104f5a today');
    assert.match(out, /<feishu>|<hex>|<b64>/);
    assert.doesNotMatch(out, /f873edab380d4836/);
  });

  await t.test('redacts UUID', () => {
    const out = redactSecretsAndPii('id 550e8400-e29b-41d4-a716-446655440000 ref');
    assert.match(out, /<uuid>/);
    assert.doesNotMatch(out, /550e8400/);
  });

  await t.test('redacts JWT starting with hyphen-friendly base64url chars', () => {
    const jwt = 'AbCdEfGhIj-_.KlMnOpQrSt-_.UvWxYzAbCd-_';
    const out = redactSecretsAndPii(jwt);
    assert.match(out, /<jwt>/);
    assert.doesNotMatch(out, /AbCd/);
  });

  await t.test('mixed input: redacts every category in one pass', () => {
    const mixed = 'user yaron@live.com phone +86 13511112222 jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c uuid 550e8400-e29b-41d4-a716-446655440000';
    const out = redactSecretsAndPii(mixed);
    assert.ok(out.length <= 64);
    // None of the original sensitive substrings survive.
    for (const leak of ['yaron@live.com', '13511112222', 'eyJhbGc', '550e8400']) {
      assert.doesNotMatch(out, new RegExp(leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  await t.test('property: sensitive tokens never leak; output ≤64 chars; paths may keep head/tail', () => {
    const sensitive = [
      ['email',        'yaron@live.com',                                                                                          'yaron@live'],
      ['phone',        '+86 135-1234-5678',                                                                                        '13512345678'],
      ['jwt',          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'eyJhbGc'],
      ['secret-kv',    'bot_token=xyzABC123def456',                                                                                'xyzABC123'],
      ['metame-token', 'bot_secret_xyzABC123def',                                                                                  'xyzABC123def'],
      ['feishu-id',    'ou_f873edab380d4836f93cc9e9b9104f5a',                                                                       'f873edab'],
      ['uuid',         '550e8400-e29b-41d4-a716-446655440000',                                                                      '550e8400'],
      ['sha256',       'deadbeefcafe1234567890abcdef1234567890abcdef1234567890abcdef1234',                                          'deadbeef'],
      ['base64',       'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=',                                                              'YWJjZGVm'],
    ];
    for (const [name, raw, fingerprint] of sensitive) {
      const out = redactSecretsAndPii(raw);
      assert.ok(out.length <= 64, `${name}: output ${out.length}>64: ${out}`);
      const escaped = fingerprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.doesNotMatch(out, new RegExp(escaped), `${name}: leaked "${fingerprint}" in output: ${out}`);
    }

    // Paths are allowed to keep head/tail intentionally — only assert length cap.
    const longPath = '/Users/yaron/AGI/MetaMe/scripts/very/deep/nested/path/with/many/components/file.js';
    assert.ok(redactSecretsAndPii(longPath).length <= 64);
    // URL-with-query: path part is preserved by design, query part must be fully dropped.
    const url = '/api/users?token=secretSauce&id=42';
    const urlOut = redactSecretsAndPii(url);
    assert.ok(urlOut.length <= 64);
    assert.doesNotMatch(urlOut, /secretSauce/);
    assert.doesNotMatch(urlOut, /\?/);
  });

  await t.test('order stability: JWT must be detected before hex/base64 swallows its segments', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactSecretsAndPii(jwt);
    assert.equal(out, '<jwt>');
  });

  await t.test('order stability: pure sha256 hex resolves to <hex> not <b64>', () => {
    const out = redactSecretsAndPii('deadbeefcafe1234567890abcdef1234567890abcdef1234567890abcdef1234');
    assert.match(out, /<hex>/);
    assert.doesNotMatch(out, /<b64>/);
  });
});

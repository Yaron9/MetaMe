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
});

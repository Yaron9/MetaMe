'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEngineName,
  normalizeCodexSandboxMode,
  normalizeCodexApprovalPolicy,
  mergeAgentMaps,
} = require('./daemon-utils');

describe('normalizeEngineName', () => {
  it('returns codex for codex input', () => {
    assert.equal(normalizeEngineName('codex'), 'codex');
    assert.equal(normalizeEngineName('CODEX'), 'codex');
    assert.equal(normalizeEngineName(' Codex '), 'codex');
  });

  it('returns claude by default', () => {
    assert.equal(normalizeEngineName('claude'), 'claude');
    assert.equal(normalizeEngineName(''), 'claude');
    assert.equal(normalizeEngineName(null), 'claude');
    assert.equal(normalizeEngineName(undefined), 'claude');
    assert.equal(normalizeEngineName('anything'), 'claude');
  });

  it('accepts custom default as string', () => {
    assert.equal(normalizeEngineName('', 'custom'), 'custom');
    assert.equal(normalizeEngineName(null, 'myengine'), 'myengine');
  });

  it('accepts custom default as function', () => {
    const getter = () => 'dynamic';
    assert.equal(normalizeEngineName('', getter), 'dynamic');
    assert.equal(normalizeEngineName('codex', getter), 'codex');
  });
});

describe('normalizeCodexSandboxMode', () => {
  it('normalizes known modes', () => {
    assert.equal(normalizeCodexSandboxMode('read-only'), 'read-only');
    assert.equal(normalizeCodexSandboxMode('readonly'), 'read-only');
    assert.equal(normalizeCodexSandboxMode('workspace-write'), 'workspace-write');
    assert.equal(normalizeCodexSandboxMode('workspace'), 'workspace-write');
    assert.equal(normalizeCodexSandboxMode('danger-full-access'), 'danger-full-access');
    assert.equal(normalizeCodexSandboxMode('dangerous'), 'danger-full-access');
    assert.equal(normalizeCodexSandboxMode('full-access'), 'danger-full-access');
    assert.equal(normalizeCodexSandboxMode('full'), 'danger-full-access');
    assert.equal(normalizeCodexSandboxMode('bypass'), 'danger-full-access');
    assert.equal(normalizeCodexSandboxMode('writable'), 'danger-full-access');
  });

  it('returns fallback for empty/unknown', () => {
    assert.equal(normalizeCodexSandboxMode(''), null);
    assert.equal(normalizeCodexSandboxMode(null), null);
    assert.equal(normalizeCodexSandboxMode('unknown'), null);
    assert.equal(normalizeCodexSandboxMode('', 'danger-full-access'), 'danger-full-access');
  });
});

describe('normalizeCodexApprovalPolicy', () => {
  it('normalizes known policies', () => {
    assert.equal(normalizeCodexApprovalPolicy('never'), 'never');
    assert.equal(normalizeCodexApprovalPolicy('no'), 'never');
    assert.equal(normalizeCodexApprovalPolicy('none'), 'never');
    assert.equal(normalizeCodexApprovalPolicy('on-failure'), 'on-failure');
    assert.equal(normalizeCodexApprovalPolicy('on_failure'), 'on-failure');
    assert.equal(normalizeCodexApprovalPolicy('on-request'), 'on-request');
    assert.equal(normalizeCodexApprovalPolicy('on_request'), 'on-request');
    assert.equal(normalizeCodexApprovalPolicy('untrusted'), 'untrusted');
  });

  it('returns fallback for empty/unknown', () => {
    assert.equal(normalizeCodexApprovalPolicy(''), null);
    assert.equal(normalizeCodexApprovalPolicy(null), null);
    assert.equal(normalizeCodexApprovalPolicy('unknown'), null);
    assert.equal(normalizeCodexApprovalPolicy('', 'never'), 'never');
  });
});

describe('mergeAgentMaps', () => {
  it('merges telegram and feishu maps', () => {
    const cfg = {
      telegram: { chat_agent_map: { tg1: 'agent_a' } },
      feishu: { chat_agent_map: { fs1: 'agent_b' } },
    };
    assert.deepEqual(mergeAgentMaps(cfg), { tg1: 'agent_a', fs1: 'agent_b' });
  });

  it('handles missing platforms gracefully', () => {
    assert.deepEqual(mergeAgentMaps({}), {});
    assert.deepEqual(mergeAgentMaps({ telegram: { chat_agent_map: { a: 'b' } } }), { a: 'b' });
  });

  it('feishu overrides telegram on conflict', () => {
    const cfg = {
      telegram: { chat_agent_map: { same: 'tg' } },
      feishu: { chat_agent_map: { same: 'fs' } },
    };
    assert.equal(mergeAgentMaps(cfg).same, 'fs');
  });

  it('includes imessage and siri_bridge maps', () => {
    const cfg = {
      telegram: { chat_agent_map: { tg1: 'a' } },
      imessage: { chat_agent_map: { im1: 'b' } },
      siri_bridge: { chat_agent_map: { siri1: 'c' } },
    };
    const result = mergeAgentMaps(cfg);
    assert.equal(result.tg1, 'a');
    assert.equal(result.im1, 'b');
    assert.equal(result.siri1, 'c');
  });
});

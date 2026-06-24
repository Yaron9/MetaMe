'use strict';

const ENGINE_NAMES = Object.freeze(['claude', 'codex', 'agy']);
const ENGINE_NAME_SET = new Set(ENGINE_NAMES);

/**
 * daemon-utils.js
 *
 * Shared normalization helpers used across daemon modules.
 * Single source of truth — no other module should redefine these.
 */

function normalizeEngineName(name, defaultEngine = 'claude') {
  const n = String(name || '').trim().toLowerCase();
  if (ENGINE_NAME_SET.has(n)) return n;
  return typeof defaultEngine === 'function' ? defaultEngine() : defaultEngine;
}

function isKnownEngineName(name) {
  return ENGINE_NAME_SET.has(String(name || '').trim().toLowerCase());
}

function normalizeCodexSandboxMode(value, fallback = null) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'read-only' || text === 'readonly') return 'read-only';
  if (text === 'workspace-write' || text === 'workspace') return 'workspace-write';
  if (
    text === 'danger-full-access'
    || text === 'dangerous'
    || text === 'full-access'
    || text === 'full'
    || text === 'bypass'
    || text === 'writable'
  ) return 'danger-full-access';
  return fallback;
}

function normalizeCodexApprovalPolicy(value, fallback = null) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'never' || text === 'no' || text === 'none') return 'never';
  if (text === 'on-failure' || text === 'on_failure' || text === 'failure') return 'on-failure';
  if (text === 'on-request' || text === 'on_request' || text === 'request') return 'on-request';
  if (text === 'untrusted') return 'untrusted';
  return fallback;
}

function mergeAgentMaps(cfg) {
  return {
    ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}),
    ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}),
    ...(cfg.weixin ? cfg.weixin.chat_agent_map : {}),
    ...(cfg.imessage ? cfg.imessage.chat_agent_map : {}),
    ...(cfg.siri_bridge ? cfg.siri_bridge.chat_agent_map : {}),
  };
}

module.exports = {
  ENGINE_NAMES,
  isKnownEngineName,
  normalizeEngineName,
  normalizeCodexSandboxMode,
  normalizeCodexApprovalPolicy,
  mergeAgentMaps,
};

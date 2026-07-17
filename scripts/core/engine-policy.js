'use strict';

const { normalizeEngineName, isKnownEngineName } = require('../daemon-utils');

function normalizeFallback(project, defaultEngine) {
  const requested = project && project.fallback_engine;
  const candidate = isKnownEngineName(requested) ? normalizeEngineName(requested) : normalizeEngineName(defaultEngine);
  return candidate === 'agy' ? 'claude' : candidate;
}

function resolveScopedEngine({
  requestedEngine,
  projectKey = '',
  project = null,
  daemonCfg = {},
  defaultEngine = 'claude',
  scope = 'project',
} = {}) {
  const requested = normalizeEngineName(requestedEngine, defaultEngine);
  if (requested !== 'agy') return { engine: requested, requested, fallback: false, reason: '' };
  const agyCfg = daemonCfg.experimental_engines && daemonCfg.experimental_engines.agy;
  const allowed = new Set(Array.isArray(agyCfg && agyCfg.allowed_projects) ? agyCfg.allowed_projects.map(String) : []);
  // Background inference is a separate trusted boundary. It is selected by the
  // distill/subconscious engine setting and does not share foreground allowlists.
  if (scope === 'background') {
    return { engine: 'agy', requested, fallback: false, reason: '' };
  }
  const allowedProject = projectKey && allowed.has(String(projectKey));
  if (agyCfg && agyCfg.enabled === true && allowedProject) {
    return { engine: 'agy', requested, fallback: false, reason: '' };
  }
  return {
    engine: normalizeFallback(project, defaultEngine),
    requested,
    fallback: true,
    reason: agyCfg && agyCfg.enabled === true ? 'project_not_allowlisted' : 'agy_disabled',
  };
}

function fallbackForUnavailableRuntime(policy, project, defaultEngine = 'claude') {
  if (!policy || policy.engine !== 'agy') return policy;
  return {
    ...policy,
    engine: normalizeFallback(project, defaultEngine),
    fallback: true,
    reason: 'agy_unavailable',
  };
}

module.exports = { resolveScopedEngine, fallbackForUnavailableRuntime };

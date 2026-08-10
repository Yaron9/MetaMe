'use strict';

const { normalizeEngineName, isKnownEngineName } = require('../daemon-utils');
const { isExperimentalEngineName } = require('./engine-descriptors');

function normalizeFallback(project, defaultEngine) {
  const requested = project && project.fallback_engine;
  const candidate = isKnownEngineName(requested) ? normalizeEngineName(requested) : normalizeEngineName(defaultEngine);
  return isExperimentalEngineName(candidate) ? 'claude' : candidate;
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
  if (!isExperimentalEngineName(requested)) {
    return { engine: requested, requested, fallback: false, reason: '' };
  }
  const experimentalCfg = daemonCfg.experimental_engines || {};
  const requestedCfg = experimentalCfg[requested];
  const allowed = new Set(Array.isArray(requestedCfg && requestedCfg.allowed_projects)
    ? requestedCfg.allowed_projects.map(String)
    : []);
  // Background inference is a separate trusted boundary. It is selected by the
  // distill/subconscious engine setting and does not share foreground allowlists.
  if (requested === 'agy' && scope === 'background') {
    return { engine: 'agy', requested, fallback: false, reason: '' };
  }
  const allowedProject = projectKey && allowed.has(String(projectKey));
  if (requestedCfg && requestedCfg.enabled === true && allowedProject) {
    return { engine: requested, requested, fallback: false, reason: '' };
  }
  return {
    engine: normalizeFallback(project, defaultEngine),
    requested,
    fallback: true,
    reason: requestedCfg && requestedCfg.enabled === true
      ? 'project_not_allowlisted'
      : `${requested}_disabled`,
  };
}

function fallbackForUnavailableRuntime(policy, project, defaultEngine = 'claude') {
  if (!policy || !isExperimentalEngineName(policy.engine)) return policy;
  return {
    ...policy,
    engine: normalizeFallback(project, defaultEngine),
    fallback: true,
    reason: `${policy.engine}_unavailable`,
  };
}

module.exports = { resolveScopedEngine, fallbackForUnavailableRuntime };

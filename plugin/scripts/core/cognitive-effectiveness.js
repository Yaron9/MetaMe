'use strict';

const STAGES = Object.freeze(['delivered', 'opened', 'applied', 'validated']);

function countStages(rows = []) {
  const counts = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  const hosts = {};
  for (const row of rows) {
    if (!STAGES.includes(row.consumer_stage)) continue;
    const n = Math.max(0, Number(row.n) || 0);
    counts[row.consumer_stage] += n;
    const host = String(row.host || row.engine || row.consumer_type || 'unknown');
    if (!hosts[host]) hosts[host] = Object.fromEntries(STAGES.map(stage => [stage, 0]));
    hosts[host][row.consumer_stage] += n;
  }
  return { counts, hosts };
}

function firstBrokenStage(counts) {
  if (counts.delivered === 0) return 'delivery';
  if (counts.opened === 0) return 'opening';
  if (counts.applied === 0) return 'application';
  if (counts.validated === 0) return 'validation';
  return null;
}

function buildEffectivenessReport({ inventory = {}, consumption = [], opportunities = 0, days = 30 } = {}) {
  const { counts, hosts } = countStages(consumption);
  const activeAssets = Object.values(inventory).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
  const brokenStage = activeAssets > 0 ? firstBrokenStage(counts) : null;
  const hasDemand = Number(opportunities) > 0 || counts.delivered > 0;
  const pauseCandidates = brokenStage === 'delivery' && hasDemand
    ? [
      inventory.facts > 0 && 'memory-extract',
      inventory.wiki > 0 && 'wiki-reflect',
      inventory.skills > 0 && 'skill-evolve',
    ].filter(Boolean)
    : [];
  return {
    days,
    inventory,
    active_assets: activeAssets,
    opportunities: Math.max(0, Number(opportunities) || 0),
    stages: counts,
    hosts,
    status: activeAssets === 0 ? 'empty' : brokenStage ? 'broken' : 'healthy',
    broken_stage: brokenStage,
    pause_candidates: pauseCandidates,
  };
}

module.exports = { STAGES, buildEffectivenessReport, _internal: { countStages, firstBrokenStage } };

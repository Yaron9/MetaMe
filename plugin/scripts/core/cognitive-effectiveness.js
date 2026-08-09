'use strict';

const STAGES = Object.freeze(['delivered', 'opened', 'applied', 'validated']);
const ASSET_TYPES = Object.freeze({ facts: 'fact', wiki: 'wiki', skills: 'skill' });

function emptyStages() {
  return Object.fromEntries(STAGES.map(stage => [stage, 0]));
}

function countStages(rows = []) {
  const counts = emptyStages();
  const hosts = {};
  const assets = Object.fromEntries(Object.values(ASSET_TYPES).map(type => [type, emptyStages()]));
  for (const row of rows) {
    if (!STAGES.includes(row.consumer_stage)) continue;
    const n = Math.max(0, Number(row.n) || 0);
    counts[row.consumer_stage] += n;
    const host = String(row.host || row.engine || row.consumer_type || 'unknown');
    if (!hosts[host]) hosts[host] = emptyStages();
    hosts[host][row.consumer_stage] += n;
    if (assets[row.asset_type]) assets[row.asset_type][row.consumer_stage] += n;
  }
  return { assets, counts, hosts };
}

function firstBrokenStage(counts) {
  if (counts.delivered === 0) return 'delivery';
  if (counts.opened === 0) return 'opening';
  if (counts.applied === 0) return 'application';
  if (counts.validated === 0) return 'validation';
  return null;
}

function buildEffectivenessReport({ inventory = {}, consumption = [], opportunities = 0, days = 30 } = {}) {
  const { assets, counts, hosts } = countStages(consumption);
  const activeAssets = Object.values(inventory).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
  const brokenStages = {};
  for (const [inventoryKey, assetType] of Object.entries(ASSET_TYPES)) {
    if (Number(inventory[inventoryKey]) > 0) brokenStages[inventoryKey] = firstBrokenStage(assets[assetType]);
  }
  const stageOrder = ['delivery', 'opening', 'application', 'validation'];
  const brokenStage = stageOrder.find(stage => Object.values(brokenStages).includes(stage)) || null;
  const hasDemand = Number(opportunities) > 0 || counts.delivered > 0;
  const pauseCandidates = hasDemand ? [
    brokenStages.facts === 'delivery' && 'memory-extract',
    brokenStages.wiki === 'delivery' && 'wiki-reflect',
    brokenStages.skills === 'delivery' && 'skill-evolve',
  ].filter(Boolean) : [];
  return {
    days,
    inventory,
    active_assets: activeAssets,
    opportunities: Math.max(0, Number(opportunities) || 0),
    stages: counts,
    asset_stages: assets,
    hosts,
    status: activeAssets === 0 ? 'empty' : brokenStage ? 'broken' : 'healthy',
    broken_stage: brokenStage,
    broken_stages: brokenStages,
    pause_candidates: pauseCandidates,
  };
}

module.exports = { ASSET_TYPES, STAGES, buildEffectivenessReport, _internal: { countStages, emptyStages, firstBrokenStage } };

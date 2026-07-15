'use strict';

const DEFAULT_EMBEDDING = Object.freeze({
  backend: 'ollama',
  model: 'bge-m3',
  dimensions: 1024,
});

const DEFAULT_EMBEDDING_TASK = Object.freeze({
  name: 'embedding-index',
  type: 'script',
  command: 'node ~/.metame/daemon-embedding.js',
  interval: '30m',
  timeout: 600,
  require_idle: false,
  notify: false,
  enabled: true,
});

function isLegacyWikiSync(command) {
  const value = String(command || '');
  return value.includes('node -e') && value.includes('runWikiReflect');
}

function reconcileDaemonConfig(input) {
  const config = structuredClone(input || {});
  const changes = [];
  config.daemon = config.daemon || {};

  if (!config.daemon.embedding) {
    config.daemon.embedding = { ...DEFAULT_EMBEDDING };
    changes.push('daemon.embedding:add-local-default');
  }

  config.heartbeat = config.heartbeat || {};
  if (!Array.isArray(config.heartbeat.tasks)) config.heartbeat.tasks = [];
  const tasks = config.heartbeat.tasks;
  const embeddingTask = tasks.find(task => task && task.name === 'embedding-index');
  if (!embeddingTask) {
    tasks.push({ ...DEFAULT_EMBEDDING_TASK });
    changes.push('heartbeat.embedding-index:add');
  }

  const wikiTask = tasks.find(task => task && task.name === 'wiki-sync');
  if (wikiTask && isLegacyWikiSync(wikiTask.command)) {
    wikiTask.command = 'node ~/.metame/wiki-reflect.js';
    changes.push('heartbeat.wiki-sync:replace-legacy-command');
  }

  return { config, changes };
}

module.exports = {
  DEFAULT_EMBEDDING,
  DEFAULT_EMBEDDING_TASK,
  reconcileDaemonConfig,
  _internal: { isLegacyWikiSync },
};

'use strict';

/**
 * scripts/core/engine-descriptors.js — single source of truth for engine identity.
 *
 * One declarative descriptor per engine. Adding a new engine = add an entry
 * here + implement its runtime in daemon-engine-runtime.js + (if its context
 * projection strategy is new) one projection adapter. Nothing else should
 * hardcode engine names for these traits — consult the descriptor instead.
 *
 * Pure data, zero dependencies. Behavior (buildArgs/parse/classify) stays in
 * daemon-engine-runtime.js; this module only declares WHAT an engine is.
 */

const ENGINE_DESCRIPTORS = Object.freeze({
  claude: Object.freeze({
    name: 'claude',
    provider: 'anthropic',
    // How SOUL/instructions reach the engine's sessions:
    //   claude-import     — workspace CLAUDE.md carries an @SOUL.md import
    //   agents-md-merge   — AGENTS.md is physically rebuilt from CLAUDE.md+SOUL.md
    //   prompt-bootstrap  — a bootstrap line in the prompt tells the engine to read them
    contextProjection: 'claude-import',
    // Where session transcripts live (session-store discovery/validation routing):
    sessionStorage: 'claude-jsonl',
    // Host-side hook installation target (index.js), null = no host hooks:
    hostHook: 'claude-settings',
  }),
  codex: Object.freeze({
    name: 'codex',
    provider: 'openai',
    contextProjection: 'agents-md-merge',
    sessionStorage: 'codex-sqlite',
    hostHook: 'codex-hooks',
  }),
  agy: Object.freeze({
    name: 'agy',
    provider: 'google',
    contextProjection: 'prompt-bootstrap',
    sessionStorage: 'agy-transcript',
    hostHook: null,
  }),
});

const ENGINE_NAMES = Object.freeze(Object.keys(ENGINE_DESCRIPTORS));

function getEngineDescriptor(name) {
  return ENGINE_DESCRIPTORS[String(name || '').trim().toLowerCase()] || null;
}

module.exports = { ENGINE_DESCRIPTORS, ENGINE_NAMES, getEngineDescriptor };

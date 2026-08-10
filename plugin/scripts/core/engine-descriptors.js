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
    // The final Engine Plugin contract uses `id`/`vendor` while the legacy
    // aliases below remain part of the descriptor for persisted/configured
    // callers.  They intentionally carry the same values.
    id: 'claude',
    displayName: 'Claude Code',
    vendor: 'anthropic',
    executableNames: Object.freeze(['claude']),
    nativeSessionKind: 'claude-jsonl',
    configSchemaVersion: 1,
    capabilities: Object.freeze({
      runtime: Object.freeze({ state: 'verified' }),
      sessionSource: Object.freeze({ state: 'unsupported' }),
      cognitiveHost: Object.freeze({ state: 'unsupported' }),
    }),
    // Legacy aliases — do not remove without a persisted-config migration.
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
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    executableNames: Object.freeze(['codex']),
    nativeSessionKind: 'codex-sqlite',
    configSchemaVersion: 1,
    capabilities: Object.freeze({
      runtime: Object.freeze({ state: 'verified' }),
      sessionSource: Object.freeze({ state: 'unsupported' }),
      cognitiveHost: Object.freeze({ state: 'unsupported' }),
    }),
    name: 'codex',
    provider: 'openai',
    contextProjection: 'agents-md-merge',
    sessionStorage: 'codex-sqlite',
    hostHook: 'codex-hooks',
  }),
  agy: Object.freeze({
    id: 'agy',
    displayName: 'agy',
    vendor: 'google',
    executableNames: Object.freeze(['agy']),
    nativeSessionKind: 'agy-transcript',
    configSchemaVersion: 1,
    capabilities: Object.freeze({
      runtime: Object.freeze({ state: 'verified' }),
      sessionSource: Object.freeze({ state: 'unsupported' }),
      cognitiveHost: Object.freeze({ state: 'unsupported' }),
    }),
    name: 'agy',
    provider: 'google',
    contextProjection: 'prompt-bootstrap',
    sessionStorage: 'agy-transcript',
    hostHook: null,
  }),
  pi: Object.freeze({
    id: 'pi',
    displayName: 'Pi',
    vendor: 'earendil-works',
    executableNames: Object.freeze(['pi']),
    nativeSessionKind: 'pi-jsonl',
    configSchemaVersion: 1,
    capabilities: Object.freeze({
      // The adapter probes the installed binary at runtime.  The descriptor
      // declares the protocol capability; availability remains opt-in and
      // probe-derived rather than being inferred from this static document.
      runtime: Object.freeze({ state: 'verified' }),
      sessionSource: Object.freeze({ state: 'unsupported' }),
      cognitiveHost: Object.freeze({ state: 'unsupported' }),
    }),
    name: 'pi',
    // `provider` is the legacy descriptor alias for vendor; the runtime's
    // model provider default is declared separately in ENGINE_MODEL_CONFIG.
    provider: 'earendil-works',
    // Pi natively discovers project context files; no host-side rewrite is
    // needed for the reference adapter.
    contextProjection: 'prompt-bootstrap',
    sessionStorage: 'pi-jsonl',
    hostHook: null,
  }),
});

const ENGINE_NAMES = Object.freeze(Object.keys(ENGINE_DESCRIPTORS));
const EXPERIMENTAL_ENGINE_NAMES = Object.freeze(['agy', 'pi']);
const EXPERIMENTAL_ENGINE_NAME_SET = new Set(EXPERIMENTAL_ENGINE_NAMES);

function getEngineDescriptor(name) {
  return ENGINE_DESCRIPTORS[String(name || '').trim().toLowerCase()] || null;
}

function isExperimentalEngineName(name) {
  return EXPERIMENTAL_ENGINE_NAME_SET.has(String(name || '').trim().toLowerCase());
}

module.exports = {
  ENGINE_DESCRIPTORS,
  ENGINE_NAMES,
  EXPERIMENTAL_ENGINE_NAMES,
  getEngineDescriptor,
  isExperimentalEngineName,
};

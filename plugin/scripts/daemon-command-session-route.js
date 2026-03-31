'use strict';

const { normalizeEngineName: _normalizeEngine } = require('./daemon-utils');
const {
  buildBoundSessionChatId,
  resolveSessionRoute: _resolveSessionRoute,
} = require('./core/team-session-route');

function createCommandSessionResolver(deps) {
  const {
    path,
    loadConfig,
    loadState,
    getSession,
    getSessionForEngine,
    getDefaultEngine = () => 'claude',
  } = deps;

  function normalizeEngineName(name) {
    return _normalizeEngine(name, getDefaultEngine);
  }

  function inferStoredEngine(rawSession) {
    if (!rawSession || typeof rawSession !== 'object') return getDefaultEngine();
    if (rawSession.engine) return normalizeEngineName(rawSession.engine);
    const slots = rawSession.engines && typeof rawSession.engines === 'object' ? rawSession.engines : null;
    if (!slots) return getDefaultEngine();
    const started = Object.entries(slots).find(([, slot]) => slot && slot.started);
    if (started) return normalizeEngineName(started[0]);
    const available = Object.keys(slots);
    return available.length === 1 ? normalizeEngineName(available[0]) : getDefaultEngine();
  }

  function normalizeRouteCwd(cwd) {
    if (!cwd) return null;
    try {
      let s = String(cwd);
      // Expand ~ to HOME before resolving (path.resolve does not handle ~)
      if (s.startsWith('~/') || s === '~') {
        const home = process.env.HOME || require('os').homedir();
        s = s === '~' ? home : path.join(home, s.slice(2));
      }
      return path.resolve(s);
    } catch {
      return String(cwd);
    }
  }

  function getSessionRoute(chatId) {
    return _resolveSessionRoute({
      chatId,
      cfg: loadConfig(),
      state: loadState(),
      getSession,
      normalizeCwd: normalizeRouteCwd,
      normalizeEngineName,
      inferStoredEngine,
    });
  }

  function getActiveSession(chatId) {
    const route = getSessionRoute(chatId);
    const rawSession = getSession(route.sessionChatId) || getSession(chatId);
    const engine = normalizeEngineName((rawSession && rawSession.engine) || route.engine);
    const engineSession = getSessionForEngine(route.sessionChatId, engine)
      || getSessionForEngine(chatId, engine);
    if (engineSession && engineSession.id) {
      return {
        route,
        sessionKey: route.sessionChatId,
        engine,
        session: engineSession,
      };
    }
    if (rawSession && rawSession.id) {
      return {
        route,
        sessionKey: route.sessionChatId,
        engine,
        session: { cwd: rawSession.cwd, engine, id: rawSession.id, started: !!rawSession.started },
      };
    }
    return {
      route,
      sessionKey: route.sessionChatId,
      engine,
      session: null,
    };
  }

  return {
    normalizeEngineName,
    inferStoredEngine,
    buildBoundSessionChatId,
    normalizeRouteCwd,
    getSessionRoute,
    getActiveSession,
  };
}

module.exports = { createCommandSessionResolver };

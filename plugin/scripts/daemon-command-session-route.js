'use strict';

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
    return String(name || '').trim().toLowerCase() === 'codex' ? 'codex' : getDefaultEngine();
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

  function buildBoundSessionChatId(projectKey) {
    const key = String(projectKey || '').trim();
    return key ? `_bound_${key}` : '';
  }

  function normalizeRouteCwd(cwd) {
    if (!cwd) return null;
    try {
      return path.resolve(String(cwd));
    } catch {
      return String(cwd);
    }
  }

  function getSessionRoute(chatId) {
    const cfg = loadConfig();
    const state = loadState();
    const chatKey = String(chatId);
    const agentMap = { ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}), ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}) };
    const boundKey = agentMap[chatKey] || null;
    const boundProj = boundKey && cfg.projects ? cfg.projects[boundKey] : null;
    const stickyKey = state && state.team_sticky ? state.team_sticky[chatKey] : null;
    const stickyMember = stickyKey && boundProj && Array.isArray(boundProj.team)
      ? boundProj.team.find((m) => m && m.key === stickyKey)
      : null;

    if (stickyMember) {
      return {
        sessionChatId: `_agent_${stickyMember.key}`,
        cwd: normalizeRouteCwd(stickyMember.cwd || (boundProj && boundProj.cwd) || null),
        engine: normalizeEngineName(stickyMember.engine || (boundProj && boundProj.engine)),
      };
    }

    if (boundProj) {
      return {
        sessionChatId: buildBoundSessionChatId(boundKey),
        cwd: normalizeRouteCwd(boundProj.cwd || null),
        engine: normalizeEngineName(boundProj.engine),
      };
    }

    const rawSession = getSession(chatId);
    return {
      sessionChatId: String(chatId),
      cwd: rawSession && rawSession.cwd ? normalizeRouteCwd(rawSession.cwd) : null,
      engine: inferStoredEngine(rawSession),
    };
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

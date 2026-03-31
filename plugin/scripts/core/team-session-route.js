'use strict';

const { rawChatId: _rawChatId } = require('./thread-chat-id');

function buildBoundSessionChatId(projectKey) {
  const key = String(projectKey || '').trim();
  return key ? `_bound_${key}` : '';
}

function isAgentLogicalRouteForMember(logicalChatId, memberKey) {
  const route = String(logicalChatId || '');
  const key = String(memberKey || '').trim();
  if (!route || !key) return false;
  const base = `_agent_${key}`;
  return route === base || route.startsWith(`${base}::`);
}

function resolveBoundTeamContext({ chatId, cfg, state, normalizeCwd }) {
  const chatKey = String(chatId || '');
  const rawChatKey = _rawChatId(chatKey);
  const agentMap = {
    ...(cfg && cfg.telegram ? cfg.telegram.chat_agent_map : {}),
    ...(cfg && cfg.feishu ? cfg.feishu.chat_agent_map : {}),
    ...(cfg && cfg.imessage ? cfg.imessage.chat_agent_map : {}),
    ...(cfg && cfg.siri_bridge ? cfg.siri_bridge.chat_agent_map : {}),
  };
  const boundKey = agentMap[chatKey] || agentMap[rawChatKey] || null;
  const boundProj = boundKey && cfg && cfg.projects ? cfg.projects[boundKey] : null;
  const stickyKey = state && state.team_sticky
    ? (state.team_sticky[chatKey] || state.team_sticky[rawChatKey] || null)
    : null;
  const stickyMember = stickyKey && boundProj && Array.isArray(boundProj.team)
    ? boundProj.team.find((member) => member && member.key === stickyKey) || null
    : null;
  const stickyLogicalChatId = state && state.team_session_route
    ? (state.team_session_route[chatKey] || state.team_session_route[rawChatKey] || null)
    : null;
  const normalizedStickyCwd = stickyMember && stickyMember.cwd ? normalizeCwd(stickyMember.cwd) : null;
  const normalizedBoundCwd = boundProj && boundProj.cwd ? normalizeCwd(boundProj.cwd) : null;

  return {
    chatKey,
    rawChatKey,
    boundKey,
    boundProj,
    stickyKey,
    stickyMember,
    stickyLogicalChatId,
    normalizedStickyCwd,
    normalizedBoundCwd,
  };
}

function resolveSessionRoute({
  chatId,
  cfg,
  state,
  getSession,
  normalizeCwd,
  normalizeEngineName,
  inferStoredEngine,
}) {
  const ctx = resolveBoundTeamContext({ chatId, cfg, state, normalizeCwd });

  if (ctx.stickyMember) {
    return {
      sessionChatId: isAgentLogicalRouteForMember(ctx.stickyLogicalChatId, ctx.stickyMember.key)
        ? ctx.stickyLogicalChatId
        : `_agent_${ctx.stickyMember.key}`,
      cwd: ctx.normalizedStickyCwd || ctx.normalizedBoundCwd,
      engine: normalizeEngineName(ctx.stickyMember.engine || (ctx.boundProj && ctx.boundProj.engine)),
      context: ctx,
    };
  }

  if (ctx.boundProj) {
    return {
      sessionChatId: buildBoundSessionChatId(ctx.boundKey),
      cwd: ctx.normalizedBoundCwd,
      engine: normalizeEngineName(ctx.boundProj.engine),
      context: ctx,
    };
  }

  const rawSession = getSession(chatId);
  return {
    sessionChatId: String(chatId || ''),
    cwd: rawSession && rawSession.cwd ? normalizeCwd(rawSession.cwd) : null,
    engine: inferStoredEngine(rawSession),
    context: ctx,
  };
}

function resolveResumeRouteForTarget({
  chatId,
  targetCwd,
  cfg,
  state,
  normalizeCwd,
  fallbackSessionChatId,
}) {
  const ctx = resolveBoundTeamContext({ chatId, cfg, state, normalizeCwd });
  const normalizedTargetCwd = targetCwd ? normalizeCwd(targetCwd) : null;
  if (!ctx.boundProj || !Array.isArray(ctx.boundProj.team) || !normalizedTargetCwd) {
    return { sessionChatId: fallbackSessionChatId, stickyKey: null, clearSticky: false };
  }

  const matchedMember = ctx.boundProj.team.find((member) => {
    if (!member || !member.cwd) return false;
    return normalizeCwd(member.cwd) === normalizedTargetCwd;
  });
  if (matchedMember) {
    return {
      sessionChatId: `_agent_${matchedMember.key}`,
      stickyKey: matchedMember.key,
      clearSticky: false,
    };
  }

  if (ctx.normalizedBoundCwd && ctx.normalizedBoundCwd === normalizedTargetCwd) {
    return {
      sessionChatId: buildBoundSessionChatId(ctx.boundKey),
      stickyKey: ctx.stickyKey || null,
      clearSticky: !!ctx.stickyKey,
    };
  }

  return {
    sessionChatId: buildBoundSessionChatId(ctx.boundKey),
    stickyKey: null,
    clearSticky: true,
  };
}

function applyResumeRouteState(state, chatId, resumeRoute) {
  const chatKey = String(chatId || '');
  const rawChatKey = _rawChatId(chatKey);
  if (resumeRoute.clearSticky && state.team_sticky) {
    delete state.team_sticky[chatKey];
    delete state.team_sticky[rawChatKey];
  }
  if (resumeRoute.clearSticky && state.team_session_route) {
    delete state.team_session_route[chatKey];
    delete state.team_session_route[rawChatKey];
  }
  if (!resumeRoute.stickyKey) return;
  if (!state.team_sticky) state.team_sticky = {};
  state.team_sticky[chatKey] = resumeRoute.stickyKey;
  state.team_sticky[rawChatKey] = resumeRoute.stickyKey;
  if (resumeRoute.sessionChatId && resumeRoute.sessionChatId.startsWith('_agent_')) {
    if (!state.team_session_route) state.team_session_route = {};
    state.team_session_route[chatKey] = resumeRoute.sessionChatId;
    state.team_session_route[rawChatKey] = resumeRoute.sessionChatId;
  }
}

module.exports = {
  buildBoundSessionChatId,
  isAgentLogicalRouteForMember,
  resolveBoundTeamContext,
  resolveSessionRoute,
  resolveResumeRouteForTarget,
  applyResumeRouteState,
};

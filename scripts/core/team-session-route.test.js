'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildBoundSessionChatId,
  isAgentLogicalRouteForMember,
  resolveSessionRoute,
  resolveResumeRouteForTarget,
  applyResumeRouteState,
} = require('./team-session-route');

describe('team-session-route', () => {
  const cfg = {
    feishu: {
      chat_agent_map: {
        'oc_team': 'jarvis',
      },
    },
    projects: {
      jarvis: {
        cwd: '/repo/main',
        engine: 'codex',
        team: [
          { key: 'jia', cwd: '/repo/jia', engine: 'codex' },
        ],
      },
    },
  };

  const normalizeCwd = (value) => String(value || '');
  const normalizeEngineName = (value) => String(value || 'claude');
  const inferStoredEngine = (raw) => raw && raw.engine ? raw.engine : 'claude';

  it('prefers persisted logical team session route as the single source of truth', () => {
    const state = {
      team_sticky: { oc_team: 'jia' },
      team_session_route: { oc_team: '_agent_jia' },
    };
    const getSession = () => null;

    const route = resolveSessionRoute({
      chatId: 'thread:oc_team:om_resume_followup',
      cfg,
      state,
      getSession,
      normalizeCwd,
      normalizeEngineName,
      inferStoredEngine,
    });

    assert.equal(route.sessionChatId, '_agent_jia');
    assert.equal(route.cwd, '/repo/jia');
    assert.equal(route.engine, 'codex');
  });

  it('ignores persisted team route values that belong to another member prefix', () => {
    const state = {
      team_sticky: { oc_team: 'jia' },
      team_session_route: { oc_team: '_agent_jia2' },
    };

    const route = resolveSessionRoute({
      chatId: 'thread:oc_team:om_resume_followup',
      cfg,
      state,
      getSession: () => null,
      normalizeCwd,
      normalizeEngineName,
      inferStoredEngine,
    });

    assert.equal(route.sessionChatId, '_agent_jia');
  });

  it('resolves team-member resume targets onto the matching logical member session', () => {
    const route = resolveResumeRouteForTarget({
      chatId: 'thread:oc_team:om_root',
      targetCwd: '/repo/jia',
      cfg,
      state: {},
      normalizeCwd,
      fallbackSessionChatId: buildBoundSessionChatId('jarvis'),
    });

    assert.deepEqual(route, {
      sessionChatId: '_agent_jia',
      stickyKey: 'jia',
      clearSticky: false,
    });
  });

  it('clears sticky and falls back to the bound project session for unmatched resume targets', () => {
    const route = resolveResumeRouteForTarget({
      chatId: 'thread:oc_team:om_root',
      targetCwd: '/repo/other',
      cfg,
      state: {
        team_sticky: { oc_team: 'jia' },
        team_session_route: { oc_team: '_agent_jia' },
      },
      normalizeCwd,
      fallbackSessionChatId: '_agent_jia',
    });

    assert.deepEqual(route, {
      sessionChatId: '_bound_jarvis',
      stickyKey: null,
      clearSticky: true,
    });
  });

  it('writes sticky member and logical route back to both thread and raw chat ids', () => {
    const state = {};
    applyResumeRouteState(state, 'thread:oc_team:om_root', {
      sessionChatId: '_agent_jia',
      stickyKey: 'jia',
      clearSticky: false,
    });

    assert.equal(state.team_sticky['thread:oc_team:om_root'], 'jia');
    assert.equal(state.team_sticky.oc_team, 'jia');
    assert.equal(state.team_session_route['thread:oc_team:om_root'], '_agent_jia');
    assert.equal(state.team_session_route.oc_team, '_agent_jia');
  });

  it('matches only the exact member route or its thread suffix', () => {
    assert.equal(isAgentLogicalRouteForMember('_agent_jia', 'jia'), true);
    assert.equal(isAgentLogicalRouteForMember('_agent_jia::thread:oc_team:om1', 'jia'), true);
    assert.equal(isAgentLogicalRouteForMember('_agent_jia2', 'jia'), false);
  });
});

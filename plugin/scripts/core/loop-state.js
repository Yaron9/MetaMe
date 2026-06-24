'use strict';

const GOAL_TRANSITIONS = Object.freeze({
  active: new Set(['paused', 'completed', 'cancelled', 'archived']),
  paused: new Set(['active', 'cancelled', 'archived']),
  completed: new Set(['active', 'archived']),
  cancelled: new Set(['archived']),
  archived: new Set(),
});

const RUN_TRANSITIONS = Object.freeze({
  queued: new Set(['planning', 'skipped', 'blocked', 'cancelled']),
  planning: new Set(['awaiting_approval', 'executing', 'skipped', 'blocked', 'cancelled']),
  awaiting_approval: new Set(['executing', 'blocked', 'cancelled']),
  executing: new Set(['verifying', 'retry_wait', 'failed', 'blocked', 'cancelled']),
  verifying: new Set(['succeeded', 'awaiting_review', 'retry_wait', 'failed', 'blocked', 'cancelled']),
  awaiting_review: new Set(['succeeded', 'failed', 'blocked', 'cancelled']),
  retry_wait: new Set(['executing', 'failed', 'blocked', 'cancelled']),
  succeeded: new Set(),
  failed: new Set(),
  blocked: new Set(),
  cancelled: new Set(),
  skipped: new Set(),
});

const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'awaiting_review',
  'retry_wait',
]);

function canTransition(table, from, to) {
  return !!(table[from] && table[from].has(to));
}

function assertTransition(table, entity, from, to) {
  if (from === to) return;
  if (!canTransition(table, from, to)) {
    throw new Error(`invalid_${entity}_transition:${from}->${to}`);
  }
}

function assertGoalTransition(from, to) {
  assertTransition(GOAL_TRANSITIONS, 'goal', from, to);
}

function assertRunTransition(from, to) {
  assertTransition(RUN_TRANSITIONS, 'run', from, to);
}

function isActiveRunStatus(status) {
  return ACTIVE_RUN_STATUSES.has(status);
}

module.exports = {
  GOAL_TRANSITIONS,
  RUN_TRANSITIONS,
  ACTIVE_RUN_STATUSES,
  assertGoalTransition,
  assertRunTransition,
  isActiveRunStatus,
};

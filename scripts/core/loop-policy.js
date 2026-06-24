'use strict';

function positiveLimit(value, fallback = Infinity) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function evaluateRunPolicy(input = {}) {
  const run = input.run || {};
  const policy = input.policy || {};
  const usage = input.usage || {};
  const maxAttempts = positiveLimit(
    policy.max_attempts_per_run || policy.max_turns_per_run,
    3
  );
  if (Number(run.attempt_no) >= maxAttempts) return { allowed: false, reason: 'attempt_limit_reached' };
  const totalTokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
  if (totalTokens >= positiveLimit(policy.max_tokens_per_run)) {
    return { allowed: false, reason: 'token_budget_reached' };
  }
  if (Number(usage.cost_micros || 0) >= positiveLimit(policy.max_cost_micros)) {
    return { allowed: false, reason: 'cost_budget_reached' };
  }
  const createdAt = new Date(run.created_at || 0).getTime();
  if (createdAt > 0 && Number(input.nowMs || Date.now()) - createdAt >= positiveLimit(policy.max_run_ms)) {
    return { allowed: false, reason: 'wall_time_limit_reached' };
  }
  return { allowed: true, reason: null };
}

module.exports = { evaluateRunPolicy };

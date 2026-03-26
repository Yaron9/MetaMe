'use strict';

/**
 * core/reactive-signal.js — Pure function for no-signal decision logic
 *
 * Determines the next action when a reactive agent completes output:
 * proceed, retry (if no signal detected), or pause (after max retries).
 * Zero I/O, zero side effects.
 */

/**
 * Calculate the next action based on signal presence and retry count.
 *
 * @param {object} params
 * @param {boolean} params.hasSignals - Whether any signals were detected in output
 * @param {boolean} params.isComplete - Whether completion signal was detected
 * @param {number} params.noSignalCount - Current consecutive no-signal count
 * @param {number} params.maxRetries - Maximum retries before pausing
 * @returns {{ action: 'proceed'|'retry'|'pause', nextNoSignalCount: number, pauseReason?: string }}
 */
function calculateNextAction({ hasSignals, isComplete, noSignalCount, maxRetries }) {
  if (isComplete) {
    return { action: 'proceed', nextNoSignalCount: 0 };
  }

  if (hasSignals) {
    return { action: 'proceed', nextNoSignalCount: 0 };
  }

  // No signals detected
  const nextCount = noSignalCount + 1;

  if (nextCount >= maxRetries) {
    return { action: 'pause', nextNoSignalCount: nextCount, pauseReason: 'no_signal_repeated' };
  }

  return { action: 'retry', nextNoSignalCount: nextCount };
}

module.exports = { calculateNextAction };

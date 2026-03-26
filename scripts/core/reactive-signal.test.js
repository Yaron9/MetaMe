'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { calculateNextAction } = require('./reactive-signal');

describe('calculateNextAction', () => {
  it('returns proceed with count=0 when isComplete', () => {
    const result = calculateNextAction({
      hasSignals: false,
      isComplete: true,
      noSignalCount: 2,
      maxRetries: 3,
    });
    assert.equal(result.action, 'proceed');
    assert.equal(result.nextNoSignalCount, 0);
    assert.equal(result.pauseReason, undefined);
  });

  it('returns proceed with count=0 when hasSignals (not complete)', () => {
    const result = calculateNextAction({
      hasSignals: true,
      isComplete: false,
      noSignalCount: 1,
      maxRetries: 3,
    });
    assert.equal(result.action, 'proceed');
    assert.equal(result.nextNoSignalCount, 0);
  });

  it('returns retry when no signals and count+1 < maxRetries', () => {
    const result = calculateNextAction({
      hasSignals: false,
      isComplete: false,
      noSignalCount: 0,
      maxRetries: 3,
    });
    assert.equal(result.action, 'retry');
    assert.equal(result.nextNoSignalCount, 1);
    assert.equal(result.pauseReason, undefined);
  });

  it('returns retry when count+1 is still less than maxRetries', () => {
    const result = calculateNextAction({
      hasSignals: false,
      isComplete: false,
      noSignalCount: 1,
      maxRetries: 3,
    });
    assert.equal(result.action, 'retry');
    assert.equal(result.nextNoSignalCount, 2);
  });

  it('returns pause when count+1 >= maxRetries', () => {
    const result = calculateNextAction({
      hasSignals: false,
      isComplete: false,
      noSignalCount: 2,
      maxRetries: 3,
    });
    assert.equal(result.action, 'pause');
    assert.equal(result.nextNoSignalCount, 3);
    assert.equal(result.pauseReason, 'no_signal_repeated');
  });

  it('returns pause when count already exceeds maxRetries', () => {
    const result = calculateNextAction({
      hasSignals: false,
      isComplete: false,
      noSignalCount: 5,
      maxRetries: 3,
    });
    assert.equal(result.action, 'pause');
    assert.equal(result.nextNoSignalCount, 6);
    assert.equal(result.pauseReason, 'no_signal_repeated');
  });

  it('isComplete takes priority over hasSignals', () => {
    const result = calculateNextAction({
      hasSignals: true,
      isComplete: true,
      noSignalCount: 2,
      maxRetries: 3,
    });
    assert.equal(result.action, 'proceed');
    assert.equal(result.nextNoSignalCount, 0);
  });
});

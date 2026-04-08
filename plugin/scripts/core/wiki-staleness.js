'use strict';

/**
 * calcStaleness — pure function, no I/O, no DB.
 *
 * @param {number} newFacts       number of new facts discovered
 * @param {number} rawSourceCount number of already-indexed raw sources
 * @returns {number} staleness in [0, 1]
 *   formula: newFacts / (rawSourceCount + newFacts)
 *   special: both zero → 0 (avoids division by zero)
 */
function calcStaleness(newFacts, rawSourceCount) {
  const denominator = rawSourceCount + newFacts;
  if (denominator === 0) return 0;
  return newFacts / denominator;
}

module.exports = { calcStaleness };

'use strict';

const COMPLETION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'artifacts', 'claims', 'next'],
  properties: {
    status: { type: 'string', enum: ['candidate_complete', 'blocked', 'failed'] },
    summary: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
    claims: { type: 'array', items: { type: 'string' } },
    next: { type: ['string', 'null'] },
  },
});

function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('completion_result_not_json');
  }
}

function unwrapNativeResult(nativeResult) {
  const parsed = parseJson(nativeResult);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (parsed.structured_output !== undefined) return parseJson(parsed.structured_output);
  if (parsed.structuredOutput !== undefined) return parseJson(parsed.structuredOutput);
  if (parsed.result !== undefined && typeof parsed.result === 'string') {
    try { return parseJson(parsed.result); } catch { return parsed; }
  }
  return parsed;
}

function normalizeCompletionResult(nativeResult) {
  const result = unwrapNativeResult(nativeResult);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('completion_result_object_required');
  }
  if (!COMPLETION_SCHEMA.properties.status.enum.includes(result.status)) {
    throw new Error('completion_status_invalid');
  }
  if (typeof result.summary !== 'string') throw new Error('completion_summary_required');
  if (!Array.isArray(result.artifacts) || !result.artifacts.every(item => typeof item === 'string')) {
    throw new Error('completion_artifacts_invalid');
  }
  if (!Array.isArray(result.claims) || !result.claims.every(item => typeof item === 'string')) {
    throw new Error('completion_claims_invalid');
  }
  if (result.next !== null && typeof result.next !== 'string') throw new Error('completion_next_invalid');
  return {
    status: result.status,
    summary: result.summary,
    artifacts: result.artifacts,
    claims: result.claims,
    next: result.next,
  };
}

module.exports = { COMPLETION_SCHEMA, normalizeCompletionResult };

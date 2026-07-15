'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('./qmd-client');

test('buildSearchArguments targets the current QMD query schema', () => {
  assert.deepEqual(_internal.buildSearchArguments('release notes', 4), {
    searches: [
      { type: 'lex', query: 'release notes' },
      { type: 'vec', query: 'release notes' },
    ],
    collections: ['metame-facts'],
    intent: 'Find MetaMe remembered facts relevant to the user request.',
    limit: 4,
    minScore: 0.3,
  });
});

test('parseSearchResult handles current MCP structuredContent', () => {
  const result = {
    content: [{ type: 'text', text: 'Found 1 result' }],
    structuredContent: {
      results: [{ file: 'qmd://metame-facts/f-abc123.md', score: 0.91 }],
    },
  };
  assert.deepEqual(_internal.parseSearchResult(result), ['f-abc123']);
});

test('parseSearchResult keeps CLI JSON compatibility', () => {
  const result = JSON.stringify([
    { file: 'qmd://metame-facts/f-one.md', score: 0.8 },
    { file: 'qmd://metame-facts/not-a-fact.md', score: 0.7 },
    { path: '/tmp/f-two.md', score: 0.6 },
  ]);
  assert.deepEqual(_internal.parseSearchResult(result), ['f-one', 'f-two']);
});

test('parseSearchResult returns null for summaries without structured results', () => {
  assert.equal(
    _internal.parseSearchResult({ content: [{ type: 'text', text: 'No results found' }] }),
    null,
  );
});

test('searchViaHttp initializes an MCP session before calling query', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ payload, headers: options.headers });
    if (payload.method === 'initialize') {
      return { ok: true, headers: { get: () => 'session-123' } };
    }
    if (payload.method === 'notifications/initialized') return { ok: true };
    return {
      ok: true,
      json: async () => ({
        result: {
          structuredContent: {
            results: [{ file: 'metame-facts/f-session-test.md' }],
          },
        },
      }),
    };
  };

  try {
    _internal.resetMcpSession();
    assert.deepEqual(await _internal.searchViaHttp('session query', 1), ['f-session-test']);
    assert.deepEqual(calls.map(call => call.payload.method), [
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    assert.equal(calls[2].headers['mcp-session-id'], 'session-123');
  } finally {
    _internal.resetMcpSession();
    global.fetch = originalFetch;
  }
});

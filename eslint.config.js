const nodeGlobals = {
  __dirname: 'readonly',
  __filename: 'readonly',
  AbortController: 'readonly',
  Blob: 'readonly',
  Buffer: 'readonly',
  clearImmediate: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  exports: 'writable',
  fetch: 'readonly',
  FormData: 'readonly',
  global: 'readonly',
  module: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  ReadableStream: 'readonly',
  require: 'readonly',
  Response: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

const baseRules = {
  'no-redeclare': 'error',
  'no-undef': 'error',
  'no-unused-vars': ['warn', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    caughtErrors: 'none',
    ignoreRestSiblings: true,
    varsIgnorePattern: '^_',
  }],
};

module.exports = [
  {
    files: ['index.js', 'scripts/**/*.js'],
    ignores: ['plugin/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: baseRules,
  },
  {
    files: ['scripts/**/*.test.js', 'scripts/test_*.js', 'scripts/hooks/test-*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
      },
    },
    rules: {
      ...baseRules,
      'no-unused-vars': ['warn', {
        args: 'none',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
    },
  },
];

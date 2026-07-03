'use strict';

require('./test-support/env-setup');
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempForTest } = require('./test-support/test-utils');

describe('slugFromFilename', () => {
  it('kebab-cases the basename', () => {
    const { slugFromFilename } = require('./wiki-extract');
    assert.equal(slugFromFilename('/some/path/My Document.md'), 'my-document');
  });
  it('strips extension', () => {
    const { slugFromFilename } = require('./wiki-extract');
    assert.equal(slugFromFilename('report_2026.pdf'), 'report-2026');
  });
  it('collapses multiple hyphens', () => {
    const { slugFromFilename } = require('./wiki-extract');
    assert.equal(slugFromFilename('foo--bar  baz.txt'), 'foo-bar-baz');
  });
});

describe('extractText md/txt', () => {
  it('returns content and extractor=direct for .md', async () => {
    const { extractText } = require('./wiki-extract');
    const tmpDir = mkdtempForTest('test-extract-');
    try {
      const tmpFile = path.join(tmpDir, 'source.md');
      fs.writeFileSync(tmpFile, '# Hello\nWorld');
      const result = await extractText(tmpFile);
      assert.equal(result.extractStatus, 'ok');
      assert.equal(result.extractor, 'direct');
      assert.ok(result.text.includes('Hello'));
      assert.equal(result.title, 'Hello');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns extractStatus=ok for plain .txt', async () => {
    const { extractText } = require('./wiki-extract');
    const tmpDir = mkdtempForTest('test-extract-');
    try {
      const tmpFile = path.join(tmpDir, 'source.txt');
      fs.writeFileSync(tmpFile, 'Just some text');
      const result = await extractText(tmpFile);
      assert.equal(result.extractStatus, 'ok');
      assert.ok(result.text.includes('Just some text'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('extractText error handling', () => {
  it('returns extractStatus=error for nonexistent file', async () => {
    const { extractText } = require('./wiki-extract');
    const result = await extractText('/nonexistent/file.pdf');
    assert.equal(result.extractStatus, 'error');
    assert.ok(result.errorMessage);
  });

  it('returns extractStatus=error for unsupported extension', async () => {
    const { extractText } = require('./wiki-extract');
    const result = await extractText('/some/file.docx');
    assert.equal(result.extractStatus, 'error');
    assert.ok(result.errorMessage);
  });
});

describe('sha256', () => {
  it('returns consistent hex string', () => {
    const { sha256 } = require('./wiki-extract');
    const h1 = sha256('hello');
    const h2 = sha256('hello');
    assert.equal(h1, h2);
    assert.equal(typeof h1, 'string');
    assert.equal(h1.length, 64); // sha256 = 64 hex chars
  });

  it('accepts Buffer input', () => {
    const { sha256 } = require('./wiki-extract');
    const result = sha256(Buffer.from('hello'));
    assert.equal(result.length, 64);
  });
});

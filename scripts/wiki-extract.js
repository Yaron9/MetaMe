'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function slugFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractMarkdownTitle(text) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.md' || ext === '.txt') {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const title = ext === '.md' ? extractMarkdownTitle(text) : null;
      return { text, title, extractor: 'direct', extractStatus: 'ok' };
    } catch (err) {
      return { text: '', title: null, extractor: 'direct', extractStatus: 'error', errorMessage: err.message };
    }
  }

  if (ext === '.pdf') {
    return extractPdf(filePath);
  }

  return {
    text: '', title: null, extractor: 'unknown', extractStatus: 'error',
    errorMessage: `Unsupported file type: ${ext}`,
  };
}

async function extractPdf(filePath) {
  const hasPdftotext = await checkCommand('pdftotext');

  if (hasPdftotext) {
    try {
      const { stdout } = await execFileAsync('pdftotext', [filePath, '-'], { maxBuffer: 10 * 1024 * 1024 });
      if (!stdout.trim()) {
        return {
          text: '', title: null, extractor: 'pdftotext', extractStatus: 'empty_or_scanned',
          errorMessage: 'PDF produced no text — may be a scanned image. Install OCR for support.',
        };
      }
      return { text: stdout, title: null, extractor: 'pdftotext', extractStatus: 'ok' };
    } catch {
      // fall through to pdf-parse
    }
  }

  // Fallback: pdf-parse
  try {
    const pdfParse = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    if (!data.text.trim()) {
      return {
        text: '', title: null, extractor: 'pdf-parse', extractStatus: 'empty_or_scanned',
        errorMessage: 'PDF produced no text — may be a scanned image.',
      };
    }
    return { text: data.text, title: null, extractor: 'pdf-parse', extractStatus: 'ok' };
  } catch (err) {
    const hint = hasPdftotext ? '' : ' Install poppler for better PDF support: brew install poppler';
    return {
      text: '', title: null, extractor: 'pdf-parse', extractStatus: 'error',
      errorMessage: err.message + hint,
    };
  }
}

async function checkCommand(cmd) {
  // Use 'which' without shell:true to avoid shell injection
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = { extractText, slugFromFilename, sha256 };

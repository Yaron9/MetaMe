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

/**
 * Parse flat paper text into named sections.
 *
 * @param {string} text — raw extracted text (e.g. from pdftotext)
 * @returns {{
 *   abstract: string, introduction: string, method: string,
 *   experiments: string, results: string, discussion: string,
 *   conclusion: string, references: string, _fallback: boolean
 * }}
 * _fallback is true when fewer than 2 section headers were found;
 * in that case the text is split into three equal chunks and returned
 * under 'introduction', 'method', 'results' to guarantee non-empty input
 * for downstream fact extraction.
 */
function extractSections(text) {
  // Map from canonical key → regex patterns (case-insensitive, optional number prefix)
  const PATTERNS = {
    abstract:     /^(?:\d+[\.\s]+)?(?:abstract)\s*$/i,
    introduction: /^(?:\d+[\.\s]+)?(?:introduction|background|overview)\s*$/i,
    method:       /^(?:\d+[\.\s]+)?(?:method(?:s|ology)?|approach|proposed\s+method|framework|model|architecture)\s*$/i,
    experiments:  /^(?:\d+[\.\s]+)?(?:experiments?|experimental\s+(?:setup|design)|evaluation|setup)\s*$/i,
    results:      /^(?:\d+[\.\s]+)?(?:results?|findings|performance)\s*$/i,
    discussion:   /^(?:\d+[\.\s]+)?(?:discussion|analysis|ablation)\s*$/i,
    conclusion:   /^(?:\d+[\.\s]+)?(?:conclusions?|summary|future\s+work)\s*$/i,
    references:   /^(?:\d+[\.\s]+)?(?:references|bibliography)\s*$/i,
  };

  const lines = text.split('\n');
  const hits = []; // { key, lineIdx }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.length > 80) continue; // section titles are short
    for (const [key, re] of Object.entries(PATTERNS)) {
      if (re.test(trimmed)) {
        hits.push({ key, lineIdx: i });
        break;
      }
    }
  }

  // Fallback: fewer than 2 distinct headers detected
  if (hits.length < 2) {
    const third = Math.floor(lines.length / 3);
    return {
      abstract: '',
      introduction: lines.slice(0, third).join('\n'),
      method: lines.slice(third, 2 * third).join('\n'),
      experiments: '',
      results: lines.slice(2 * third).join('\n'),
      discussion: '',
      conclusion: '',
      references: '',
      _fallback: true,
    };
  }

  // Build sections from hits
  const out = { abstract: '', introduction: '', method: '', experiments: '',
                results: '', discussion: '', conclusion: '', references: '', _fallback: false };

  for (let h = 0; h < hits.length; h++) {
    const { key, lineIdx } = hits[h];
    const endLine = h + 1 < hits.length ? hits[h + 1].lineIdx : lines.length;
    // Deduplicate: keep the longest slice if same key appears twice
    const chunk = lines.slice(lineIdx + 1, endLine).join('\n').trim();
    if (chunk.length > (out[key] || '').length) out[key] = chunk;
  }

  return out;
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

module.exports = { extractText, extractSections, slugFromFilename, sha256 };

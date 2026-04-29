'use strict';

const PATTERNS = [
  { re: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,                      to: '<jwt>'    },
  { re: /\b(bot_token|app_secret|access_token|refresh_token|api_key|api_secret|password|secret|chat_id|operator_id)[=:]\S+/gi, to: '<secret>' },
  { re: /\?[^\s]*/g,                                                                             to: ''         },
  { re: /[\w.+-]+@[\w-]+\.[\w.-]+/g,                                                             to: '<email>'  },
  { re: /\b[a-f0-9]{20,}\b/gi,                                                                   to: '<hex>'    },
  { re: /\b[A-Za-z0-9+=]{24,}\b/g,                                                               to: '<b64>'    },
  { re: /\+?\d[\d\s().-]{5,}\d/g,                                                                to: '<phone>'  },
];

const MAX_CHARS = 64;
const PATH_LONG = 80;

function redactSecretsAndPii(label) {
  if (typeof label !== 'string' || label.length === 0) return '';
  let s = label;
  for (const { re, to } of PATTERNS) s = s.replace(re, to);
  if (s.length > PATH_LONG && s.includes('/')) s = s.slice(0, 24) + '…' + s.slice(-24);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 1) + '…';
  return s;
}

module.exports = { redactSecretsAndPii };

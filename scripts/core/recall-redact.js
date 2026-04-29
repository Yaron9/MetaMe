'use strict';

// Order matters: more specific tokens before generic blob detectors.
// JWT first so its base64url segments are not eaten by hex/b64 below.
// Named-secret KV second so the value half is opaque to later patterns.
// MetaMe and Feishu open-id tokens recognized by their concrete prefixes.
// Note: base64 char-class excludes '/' to avoid eating filesystem paths;
// the practical leakage cost is small (JWT, named-secret, hex cover most cases),
// the false-positive cost of eating paths is severe.
const PATTERNS = [
  { re: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g, to: '<jwt>' },
  { re: /\b(bot_token|app_secret|access_token|refresh_token|api_key|api_secret|password|secret|chat_id|operator_id)[=:]\S+/gi, to: '<secret>' },
  { re: /\b(?:bot_secret|chat_ou|chat_oc|user_ou|user_oc|app_id_cli)_[A-Za-z0-9_-]{4,}\b/g,     to: '<metame>' },
  { re: /\bo[uc]_[A-Za-z0-9]{20,}\b/g,                                                           to: '<feishu>' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,                    to: '<uuid>'   },
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

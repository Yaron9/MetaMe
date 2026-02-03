#!/usr/bin/env node

/**
 * MetaMe Plugin — First-Run Setup
 *
 * Creates ~/.claude_profile.yaml if it doesn't exist,
 * and ensures ~/.metame/ directory is ready.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');
const METAME_DIR = path.join(HOME, '.metame');

// Ensure ~/.metame/ exists
if (!fs.existsSync(METAME_DIR)) {
  fs.mkdirSync(METAME_DIR, { recursive: true });
}

// Create minimal profile if missing
if (!fs.existsSync(BRAIN_FILE)) {
  const initialProfile = `identity:
  role: Unknown
  nickname: null
status:
  focus: Initializing
`;
  fs.writeFileSync(BRAIN_FILE, initialProfile, 'utf8');
  console.log('MetaMe: Created initial profile at ~/.claude_profile.yaml');
}

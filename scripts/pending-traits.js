#!/usr/bin/env node

/**
 * MetaMe Pending Traits Manager
 *
 * Manages the accumulation and promotion of observed preferences.
 * T3 fields need confidence threshold before writing to profile:
 *   - high confidence (strong directive / correction) → direct write
 *   - normal confidence → accumulate in pending, promote at count >= 3
 *
 * File: ~/.metame/pending_traits.yaml
 * This file is system-internal, NOT injected into prompts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_FILE = path.join(os.homedir(), '.metame', 'pending_traits.yaml');
const PROMOTION_THRESHOLD = 3;
const EXPIRY_DAYS = 30;

/**
 * Load pending traits from disk.
 * Returns plain object { 'dotted.key': { value, count, first_seen, last_seen, confidence, source_quote } }
 */
function loadPending() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return {};
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(PENDING_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * Save pending traits to disk.
 */
function savePending(pending) {
  const yaml = require('js-yaml');
  const dir = path.dirname(PENDING_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PENDING_FILE, yaml.dump(pending, { lineWidth: -1 }), 'utf8');
}

/**
 * Upsert a trait observation into pending.
 * If the value matches existing, increment count.
 * If the value differs, start a new counter (contradiction).
 */
function upsertPending(pending, key, value, confidence, sourceQuote) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = pending[key];

  if (existing && existing.value === value) {
    // Same value observed again — increment
    existing.count += 1;
    existing.last_seen = today;
    if (confidence === 'high') existing.confidence = 'high';
    if (sourceQuote) existing.source_quote = sourceQuote;
  } else if (existing && existing.value !== value) {
    // Contradiction — track it but don't delete old
    if (!existing.contradictions) existing.contradictions = 0;
    existing.contradictions += 1;
    // If contradictions outnumber original observations, replace
    if (existing.contradictions >= existing.count) {
      pending[key] = {
        value: value,
        count: 1,
        first_seen: today,
        last_seen: today,
        confidence: confidence || 'normal',
        source_quote: sourceQuote || null
      };
    }
  } else {
    // New trait
    pending[key] = {
      value: value,
      count: 1,
      first_seen: today,
      last_seen: today,
      confidence: confidence || 'normal',
      source_quote: sourceQuote || null
    };
  }
}

/**
 * Get traits ready for promotion.
 * high confidence → always promote immediately.
 * normal confidence → time-weighted count must reach threshold.
 *   effective_count = count * max(0.3, 1 - age_days/60)
 *   So recent observations count fully; 30-day-old observations count 50%;
 *   60-day-old observations count at 30% floor (not zero — prevents complete stall).
 * Returns array of { key, value, source_quote }
 */
function getPromotable(pending) {
  const ready = [];
  const now = Date.now();
  for (const [key, meta] of Object.entries(pending)) {
    if (meta.confidence === 'high') {
      ready.push({ key, value: meta.value, source_quote: meta.source_quote });
      continue;
    }
    const ageDays = Math.floor((now - new Date(meta.last_seen).getTime()) / (1000 * 60 * 60 * 24));
    const ageWeight = Math.max(0.3, 1 - ageDays / 60);
    const effectiveCount = meta.count * ageWeight;
    if (effectiveCount >= PROMOTION_THRESHOLD) {
      ready.push({ key, value: meta.value, source_quote: meta.source_quote });
    }
  }
  return ready;
}

/**
 * Remove promoted traits from pending.
 */
function removePromoted(pending, keys) {
  for (const key of keys) {
    delete pending[key];
  }
}

/**
 * Expire stale pending traits (not observed for > EXPIRY_DAYS).
 * Returns number of expired entries.
 */
function expireStale(pending) {
  const now = Date.now();
  const cutoff = EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let expired = 0;

  for (const [key, meta] of Object.entries(pending)) {
    const lastSeen = new Date(meta.last_seen).getTime();
    if (now - lastSeen > cutoff) {
      delete pending[key];
      expired++;
    }
  }
  return expired;
}

module.exports = {
  PENDING_FILE,
  loadPending,
  savePending,
  upsertPending,
  getPromotable,
  removePromoted,
  expireStale,
  PROMOTION_THRESHOLD,
  EXPIRY_DAYS,
};

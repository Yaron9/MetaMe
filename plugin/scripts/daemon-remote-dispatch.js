'use strict';

const crypto = require('crypto');

const REMOTE_DISPATCH_PREFIX = '[METAME_REMOTE_DISPATCH]';

function normalizeRemoteDispatchConfig(config) {
  const rd = config && config.feishu && config.feishu.remote_dispatch;
  if (!rd || typeof rd !== 'object') return null;
  if (!rd.enabled) return null;
  const selfPeer = String(rd.self || '').trim();
  const chatId = String(rd.chat_id || '').trim();
  const secret = String(rd.secret || '').trim();
  if (!selfPeer || !chatId || !secret) return null;
  return { selfPeer, chatId, secret };
}

function parseRemoteTargetRef(input) {
  const text = String(input || '').trim();
  const m = text.match(/^([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/);
  if (!m) return null;
  return { peer: m[1], project: m[2] };
}

function signPacket(packet, secret) {
  const body = { ...packet };
  delete body.sig;
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

function encodePacket(packet, secret) {
  const signed = { ...packet, sig: signPacket(packet, secret) };
  return `${REMOTE_DISPATCH_PREFIX} ${Buffer.from(JSON.stringify(signed), 'utf8').toString('base64')}`;
}

function decodePacket(text) {
  const src = String(text || '').trim();
  if (!src.startsWith(REMOTE_DISPATCH_PREFIX)) return null;
  const encoded = src.slice(REMOTE_DISPATCH_PREFIX.length).trim();
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function verifyPacket(packet, secret) {
  if (!packet || typeof packet !== 'object' || !packet.sig || !secret) return false;
  return signPacket(packet, secret) === packet.sig;
}

function isValidPairCode(code) {
  return /^\d{6}$/.test(String(code || '').trim());
}

function generatePairCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

function deriveSecretFromPairCode(code, chatId) {
  const normalizedCode = String(code || '').trim();
  const normalizedChatId = String(chatId || '').trim();
  if (!isValidPairCode(normalizedCode) || !normalizedChatId) return null;
  return crypto
    .createHash('sha256')
    .update(`metame-remote-dispatch|${normalizedChatId}|${normalizedCode}`)
    .digest('hex');
}

function getRemoteDispatchStatus(config) {
  const rd = normalizeRemoteDispatchConfig(config);
  if (!rd) return null;
  return {
    selfPeer: rd.selfPeer,
    chatId: rd.chatId,
    mode: 'pair-code',
    hasSecret: !!rd.secret,
  };
}

// TTL dedup map — prevents replayed packets (5 min window)
const _seenPackets = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(packetId) {
  if (!packetId) return false;
  const now = Date.now();
  for (const [id, ts] of _seenPackets) {
    if (now - ts > DEDUP_TTL_MS) _seenPackets.delete(id);
  }
  if (_seenPackets.has(packetId)) return true;
  _seenPackets.set(packetId, now);
  return false;
}

function isRemoteMember(member) {
  return !!(member && member.peer);
}

module.exports = {
  REMOTE_DISPATCH_PREFIX,
  normalizeRemoteDispatchConfig,
  parseRemoteTargetRef,
  encodePacket,
  decodePacket,
  verifyPacket,
  isValidPairCode,
  generatePairCode,
  deriveSecretFromPairCode,
  getRemoteDispatchStatus,
  isDuplicate,
  isRemoteMember,
};

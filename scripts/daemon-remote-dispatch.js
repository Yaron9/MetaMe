'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REMOTE_DISPATCH_PREFIX = '[METAME_REMOTE_DISPATCH]';
const REMOTE_PAIR_PREFIX = '[METAME_REMOTE_PAIR]';
const PAIR_CURVE = 'prime256v1';
const PAIR_HELLO_COOLDOWN_MS = 30 * 1000;

function getStateFile(homeDir = os.homedir()) {
  return path.join(homeDir, '.metame', 'dispatch', 'remote-pair-state.json');
}

function loadPairState(homeDir = os.homedir()) {
  const file = getStateFile(homeDir);
  try {
    if (!fs.existsSync(file)) return { version: 1, peers: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, peers: {} };
    if (!parsed.peers || typeof parsed.peers !== 'object') parsed.peers = {};
    return parsed;
  } catch {
    return { version: 1, peers: {} };
  }
}

function savePairState(state, homeDir = os.homedir()) {
  const file = getStateFile(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

function normalizeRemoteDispatchConfig(config) {
  const rd = config && config.feishu && config.feishu.remote_dispatch;
  if (!rd || typeof rd !== 'object') return null;
  if (!rd.enabled) return null;
  const selfPeer = String(rd.self || '').trim();
  const chatId = String(rd.chat_id || '').trim();
  const secret = String(rd.secret || '').trim();
  if (!selfPeer || !chatId) return null;
  return { selfPeer, chatId, secret: secret || null };
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

function encodePairPacket(packet) {
  return `${REMOTE_PAIR_PREFIX} ${Buffer.from(JSON.stringify(packet), 'utf8').toString('base64')}`;
}

function decodePairPacket(text) {
  const src = String(text || '').trim();
  if (!src.startsWith(REMOTE_PAIR_PREFIX)) return null;
  const encoded = src.slice(REMOTE_PAIR_PREFIX.length).trim();
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function ensurePairIdentity(selfPeer, homeDir = os.homedir()) {
  const state = loadPairState(homeDir);
  if (!state.peers[selfPeer] || typeof state.peers[selfPeer] !== 'object') {
    state.peers[selfPeer] = {};
  }
  const selfState = state.peers[selfPeer];
  if (!selfState.privateKey || !selfState.publicKey) {
    const ecdh = crypto.createECDH(PAIR_CURVE);
    ecdh.generateKeys();
    selfState.privateKey = ecdh.getPrivateKey('base64');
    selfState.publicKey = ecdh.getPublicKey('base64');
  }
  if (!selfState.remotes || typeof selfState.remotes !== 'object') selfState.remotes = {};
  savePairState(state, homeDir);
  return { state, selfState };
}

function derivePeerSecret(selfPeer, peer, privateKeyB64, peerPublicKeyB64) {
  const ecdh = crypto.createECDH(PAIR_CURVE);
  ecdh.setPrivateKey(Buffer.from(privateKeyB64, 'base64'));
  const shared = ecdh.computeSecret(Buffer.from(peerPublicKeyB64, 'base64'));
  const pairLabel = [selfPeer, peer].sort().join('|');
  return crypto.createHash('sha256').update(shared).update('|').update(pairLabel).digest('hex');
}

function learnPairHello(config, packet, homeDir = os.homedir()) {
  const rd = normalizeRemoteDispatchConfig(config);
  if (!rd || !packet || packet.type !== 'hello') return null;
  const fromPeer = String(packet.from_peer || '').trim();
  const publicKey = String(packet.public_key || '').trim();
  if (!fromPeer || !publicKey || fromPeer === rd.selfPeer) return null;

  const { state, selfState } = ensurePairIdentity(rd.selfPeer, homeDir);
  const remotes = selfState.remotes || (selfState.remotes = {});
  const current = remotes[fromPeer] || {};
  const nextSecret = derivePeerSecret(rd.selfPeer, fromPeer, selfState.privateKey, publicKey);
  const changed = current.publicKey !== publicKey || current.secret !== nextSecret;
  remotes[fromPeer] = {
    publicKey,
    secret: nextSecret,
    pairedAt: new Date().toISOString(),
    lastHelloAt: packet.ts || null,
  };
  savePairState(state, homeDir);
  return { peer: fromPeer, secret: nextSecret, changed };
}

function resolvePeerSecret(config, peer, homeDir = os.homedir()) {
  const rd = normalizeRemoteDispatchConfig(config);
  if (!rd) return null;
  const peerKey = String(peer || '').trim();
  if (!peerKey) return rd.secret || null;
  const state = loadPairState(homeDir);
  const selfState = state.peers && state.peers[rd.selfPeer];
  const remote = selfState && selfState.remotes && selfState.remotes[peerKey];
  const secret = remote && typeof remote.secret === 'string' ? remote.secret.trim() : '';
  return secret || rd.secret || null;
}

function resolvePairedPeerSecret(config, peer, homeDir = os.homedir()) {
  const rd = normalizeRemoteDispatchConfig(config);
  if (!rd) return null;
  const peerKey = String(peer || '').trim();
  if (!peerKey) return null;
  const state = loadPairState(homeDir);
  const selfState = state.peers && state.peers[rd.selfPeer];
  const remote = selfState && selfState.remotes && selfState.remotes[peerKey];
  const secret = remote && typeof remote.secret === 'string' ? remote.secret.trim() : '';
  return secret || null;
}

function buildPairHello(config, opts = {}) {
  const rd = normalizeRemoteDispatchConfig(config);
  if (!rd) return null;
  const homeDir = opts.homeDir || os.homedir();
  const now = Date.now();
  const { state, selfState } = ensurePairIdentity(rd.selfPeer, homeDir);
  const force = !!opts.force;
  const lastHelloAt = Number(selfState.lastHelloAt || 0);
  if (!force && lastHelloAt && now - lastHelloAt < PAIR_HELLO_COOLDOWN_MS) return null;

  selfState.lastHelloAt = now;
  savePairState(state, homeDir);
  return encodePairPacket({
    v: 1,
    type: 'hello',
    id: `${rd.selfPeer}_${now}_pair`,
    ts: new Date(now).toISOString(),
    from_peer: rd.selfPeer,
    public_key: selfState.publicKey,
  });
}

function getRemoteDispatchStatus(config, homeDir = os.homedir()) {
  const rd = normalizeRemoteDispatchConfig(config);
  if (!rd) return null;
  const state = loadPairState(homeDir);
  const selfState = state.peers && state.peers[rd.selfPeer];
  const remotes = selfState && selfState.remotes && typeof selfState.remotes === 'object'
    ? selfState.remotes
    : {};
  return {
    selfPeer: rd.selfPeer,
    chatId: rd.chatId,
    mode: rd.secret ? 'hybrid' : 'auto',
    hasStaticSecret: !!rd.secret,
    pairedPeers: Object.entries(remotes).map(([peer, info]) => ({
      peer,
      pairedAt: info && info.pairedAt ? info.pairedAt : null,
    })),
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
  REMOTE_PAIR_PREFIX,
  normalizeRemoteDispatchConfig,
  parseRemoteTargetRef,
  encodePacket,
  decodePacket,
  verifyPacket,
  encodePairPacket,
  decodePairPacket,
  loadPairState,
  ensurePairIdentity,
  learnPairHello,
  resolvePeerSecret,
  resolvePairedPeerSecret,
  buildPairHello,
  getRemoteDispatchStatus,
  isDuplicate,
  isRemoteMember,
};

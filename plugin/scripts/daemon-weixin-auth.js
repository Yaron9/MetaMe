'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_BASE_URL } = require('./daemon-weixin-api');

function createWeixinAuthStore(deps = {}) {
  const HOME = deps.HOME || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const apiClient = deps.apiClient;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise(resolve => setTimeout(resolve, ms));

  if (!apiClient) throw new Error('apiClient is required');

  const baseDir = pathMod.join(HOME, '.metame', 'weixin');
  const accountsDir = pathMod.join(baseDir, 'accounts');
  const sessionsDir = pathMod.join(baseDir, 'sessions');
  const indexFile = pathMod.join(baseDir, 'accounts.json');

  function ensureDirs() {
    fsMod.mkdirSync(accountsDir, { recursive: true });
    fsMod.mkdirSync(sessionsDir, { recursive: true });
  }

  function normalizeAccountId(raw) {
    return String(raw || '').trim().replace(/[^a-zA-Z0-9._@-]/g, '-');
  }

  function normalizeSessionKey(raw) {
    const value = String(raw || '').trim();
    if (!value) throw new Error('sessionKey is required');
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(value)) {
      throw new Error('invalid sessionKey: use 1-80 chars from [a-zA-Z0-9._-]');
    }
    return value;
  }

  function sessionPath(sessionKey) {
    return pathMod.join(sessionsDir, `${normalizeSessionKey(sessionKey)}.json`);
  }

  function accountPath(accountId) {
    return pathMod.join(accountsDir, `${normalizeAccountId(accountId)}.json`);
  }

  function readJson(filePath, fallback = null) {
    try {
      if (!fsMod.existsSync(filePath)) return fallback;
      return JSON.parse(fsMod.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(filePath, value) {
    ensureDirs();
    fsMod.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
    try {
      fsMod.chmodSync(filePath, 0o600);
    } catch {}
  }

  function listAccounts() {
    const ids = readJson(indexFile, []);
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  }

  function registerAccountId(accountId) {
    const normalized = normalizeAccountId(accountId);
    const next = listAccounts();
    if (!next.includes(normalized)) next.push(normalized);
    writeJson(indexFile, next);
    return normalized;
  }

  function loadAccount(accountId) {
    if (!accountId) return null;
    return readJson(accountPath(accountId), null);
  }

  function saveAccount(accountId, payload) {
    const normalized = registerAccountId(accountId);
    const next = {
      ...(loadAccount(normalized) || {}),
      ...payload,
      accountId: normalized,
      savedAt: now().toISOString(),
    };
    writeJson(accountPath(normalized), next);
    try {
      fsMod.chmodSync(accountPath(normalized), 0o600);
    } catch {}
    return next;
  }

  function loadSession(sessionKey) {
    return readJson(sessionPath(sessionKey), null);
  }

  function saveSession(sessionKey, payload) {
    const normalized = normalizeSessionKey(sessionKey);
    const next = {
      ...(loadSession(normalized) || {}),
      ...payload,
      sessionKey: normalized,
      savedAt: now().toISOString(),
    };
    writeJson(sessionPath(normalized), next);
    return next;
  }

  async function startQrLogin(params = {}) {
    const sessionKey = normalizeSessionKey(params.sessionKey || crypto.randomUUID());
    const baseUrl = String(params.baseUrl || DEFAULT_BASE_URL).trim();
    const botType = String(params.botType || '3').trim();
    const routeTag = params.routeTag === undefined || params.routeTag === null ? null : String(params.routeTag).trim();
    const qr = await apiClient.getBotQrCode({ baseUrl, botType, routeTag });
    const session = saveSession(sessionKey, {
      baseUrl,
      botType,
      routeTag,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: now().toISOString(),
      rawStartResponse: qr,
    });
    log('INFO', `[WEIXIN] QR login started session=${sessionKey} bot_type=${botType}`);
    return session;
  }

  async function waitForQrLogin(params = {}) {
    const sessionKey = normalizeSessionKey(params.sessionKey || '');
    const session = loadSession(sessionKey);
    if (!session || !session.qrcode) throw new Error(`weixin session not found: ${sessionKey}`);
    const timeoutMs = Math.max(Number(params.timeoutMs || 480000), 1000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await apiClient.getQrCodeStatus({
        baseUrl: session.baseUrl,
        qrcode: session.qrcode,
        routeTag: session.routeTag,
      });
      saveSession(sessionKey, { lastStatus: status.status || null, status });
      if (status.status === 'confirmed') {
        const accountId = normalizeAccountId(status.ilink_bot_id || '');
        const account = saveAccount(accountId, {
          token: status.bot_token,
          baseUrl: status.baseurl || session.baseUrl,
          userId: status.ilink_user_id || '',
          botType: session.botType,
          routeTag: session.routeTag,
          linkedAt: now().toISOString(),
        });
        saveSession(sessionKey, { confirmedAt: now().toISOString(), accountId, status });
        return { connected: true, account, status };
      }
      if (status.status === 'expired') {
        return { connected: false, expired: true, status };
      }
      await sleep(params.pollIntervalMs || 1000);
    }
    return { connected: false, timeout: true };
  }

  return {
    baseDir,
    accountsDir,
    sessionsDir,
    listAccounts,
    loadAccount,
    saveAccount,
    loadSession,
    saveSession,
    startQrLogin,
    waitForQrLogin,
    normalizeAccountId,
    normalizeSessionKey,
  };
}

module.exports = {
  createWeixinAuthStore,
};

// Microsoft Graph API klient.
//
// OAuth flow:
//   1. authorizeUrl()      → user redirect na MS login
//   2. exchangeCodeForTokens(code) → po callbacku: access + refresh
//   3. getValidAccessToken(userId) → před každým Graph callem; refreshne, pokud expiroval
//
// Scopes:
//   - User.Read              (whoami)
//   - Mail.ReadWrite         (read + flag + folder ops; obsahuje i Read)
//   - Mail.Send              (poslat mail)
//   - MailboxSettings.Read   (timezone)
//   - offline_access         (refresh tokens)

import crypto from 'node:crypto';
import { query } from './db.js';
import { encryptToken, decryptToken, isEncryptionConfigured } from './crypto.js';

const SCOPES = [
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.Read',
  'offline_access',
];

function cfg() {
  return {
    clientId:     process.env.MICROSOFT_CLIENT_ID?.trim(),
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET?.trim(),
    tenantId:     process.env.MICROSOFT_TENANT_ID?.trim() || 'common',
    redirectUri:  process.env.MICROSOFT_REDIRECT_URI?.trim(),
  };
}

export function isMsConfigured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.redirectUri && isEncryptionConfigured());
}

export function msConfigStatus() {
  const c = cfg();
  return {
    has_client_id:     !!c.clientId,
    has_client_secret: !!c.clientSecret,
    has_redirect_uri:  !!c.redirectUri,
    has_encryption:    isEncryptionConfigured(),
    tenant:            c.tenantId,
  };
}

// CSRF state → in-memory mapa (timeout 10 min). Pro 1-tenant produkci OK,
// pro horizontální scale by chtělo Redis/DB.
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

export function authorizeUrl(userId) {
  const c = cfg();
  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { userId, t: Date.now() });
  // GC starých stavů
  for (const [s, v] of stateStore.entries()) {
    if (Date.now() - v.t > STATE_TTL_MS) stateStore.delete(s);
  }
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/authorize?${params}`;
}

export function consumeState(state) {
  const v = stateStore.get(state);
  if (!v) return null;
  stateStore.delete(state);
  if (Date.now() - v.t > STATE_TTL_MS) return null;
  return v.userId;
}

async function tokenRequest(form) {
  const c = cfg();
  const r = await fetch(`https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  if (!r.ok) {
    const txt = await r.text();
    const err = new Error(`MS token endpoint ${r.status}: ${txt.slice(0, 400)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export async function exchangeCodeForTokens(code) {
  const c = cfg();
  return tokenRequest({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: c.redirectUri,
    scope: SCOPES.join(' '),
  });
}

async function refreshTokens(refreshToken) {
  const c = cfg();
  return tokenRequest({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
}

// Vrátí konkrétního usera v Graph (whoami).
export async function graphGetMe(accessToken) {
  const r = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`Graph /me ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Uloží connection do DB. Volá se z callback handleru.
export async function saveConnection(userId, tokenData) {
  const access  = tokenData.access_token;
  const refresh = tokenData.refresh_token;
  const expiresIn = Number(tokenData.expires_in) || 3600;
  const expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000); // 1 min rezerva

  // Zjistíme email z whoami (Graph)
  const me = await graphGetMe(access);

  await query(`
    INSERT INTO email_connections (user_id, ms_user_id, ms_email, access_token_enc, refresh_token_enc, expires_at, scope)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id) DO UPDATE
      SET ms_user_id        = EXCLUDED.ms_user_id,
          ms_email          = EXCLUDED.ms_email,
          access_token_enc  = EXCLUDED.access_token_enc,
          refresh_token_enc = EXCLUDED.refresh_token_enc,
          expires_at        = EXCLUDED.expires_at,
          scope             = EXCLUDED.scope,
          connected_at      = NOW()
  `, [
    userId, me.id, me.mail || me.userPrincipalName,
    encryptToken(access), encryptToken(refresh), expiresAt, tokenData.scope || SCOPES.join(' '),
  ]);

  return { email: me.mail || me.userPrincipalName };
}

// Vrátí platný access token, případně refreshne.
export async function getValidAccessToken(userId) {
  const r = await query('SELECT * FROM email_connections WHERE user_id = $1', [userId]);
  const row = r.rows[0];
  if (!row) return null;

  const stillValid = new Date(row.expires_at).getTime() > Date.now() + 30 * 1000;
  if (stillValid) return decryptToken(row.access_token_enc);

  // Refresh
  let refreshTokenPlain;
  try { refreshTokenPlain = decryptToken(row.refresh_token_enc); }
  catch { return null; } // šifra rozbitá → user musí re-connect

  try {
    const td = await refreshTokens(refreshTokenPlain);
    const expiresIn = Number(td.expires_in) || 3600;
    const expiresAt = new Date(Date.now() + (expiresIn - 60) * 1000);
    await query(`
      UPDATE email_connections
      SET access_token_enc = $1,
          refresh_token_enc = $2,
          expires_at = $3,
          scope = $4
      WHERE user_id = $5
    `, [
      encryptToken(td.access_token),
      encryptToken(td.refresh_token || refreshTokenPlain),
      expiresAt, td.scope || row.scope, userId,
    ]);
    return td.access_token;
  } catch (err) {
    console.warn(`[msGraph] refresh failed pro user ${userId}: ${err.message}`);
    return null;
  }
}

// Stáhne posledních N zpráv z Inboxu.
export async function fetchInbox(accessToken, { top = 20 } = {}) {
  const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages');
  url.searchParams.set('$top', String(top));
  url.searchParams.set('$select', 'id,subject,from,receivedDateTime,bodyPreview,isRead,webLink');
  url.searchParams.set('$orderby', 'receivedDateTime DESC');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Graph inbox ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return d.value || [];
}

export async function disconnect(userId) {
  await query('DELETE FROM email_connections WHERE user_id = $1', [userId]);
}

export async function getConnectionStatus(userId) {
  const r = await query('SELECT ms_email, connected_at, last_sync_at FROM email_connections WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}

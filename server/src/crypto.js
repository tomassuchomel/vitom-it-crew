// Symetrické šifrování pro tokeny v DB (Microsoft OAuth refresh tokens atd.).
// AES-256-GCM. Master key v env (ENCRYPTION_KEY = 32 bajtů, base64).
//
// Když master key chybí nebo je špatně dlouhý, encrypt/decrypt hodí chybu —
// příslušné routes potom selhávají, ale server jako celek běží dál.

import crypto from 'node:crypto';

const ALG = 'aes-256-gcm';

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error('ENCRYPTION_KEY není nastaven v env (base64 32 bajtů).');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`ENCRYPTION_KEY musí být 32 bajtů (po base64 decode), zjištěno ${buf.length}.`);
  cachedKey = buf;
  return cachedKey;
}

// Vrací base64 string: iv(12) || authTag(16) || ciphertext
export function encryptToken(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptToken(encoded) {
  const buf = Buffer.from(String(encoded), 'base64');
  if (buf.length < 28) throw new Error('Šifrovaný token je příliš krátký.');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const dec = crypto.createDecipheriv(ALG, getKey(), iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

export function isEncryptionConfigured() {
  try { getKey(); return true; } catch { return false; }
}

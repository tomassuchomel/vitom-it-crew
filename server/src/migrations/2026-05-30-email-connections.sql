-- Microsoft 365 (Outlook) připojení per uživatel.
-- Access + refresh token uloženy ZAŠIFROVANĚ (encryptToken helper).
-- Jeden user může mít max 1 connection (kdyby chtěl víc, doplníme později).

CREATE TABLE IF NOT EXISTS email_connections (
  user_id              INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'microsoft',
  ms_user_id           TEXT,                 -- Graph user id (objectId)
  ms_email             TEXT NOT NULL,        -- email v M365 (z whoami)
  access_token_enc     TEXT NOT NULL,        -- AES-256-GCM, base64
  refresh_token_enc    TEXT NOT NULL,
  expires_at           TIMESTAMPTZ NOT NULL,
  scope                TEXT,
  connected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at         TIMESTAMPTZ
);

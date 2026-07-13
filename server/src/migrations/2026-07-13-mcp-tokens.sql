-- Per-user MCP tokeny. Každý uživatel si může vytvořit vlastní token,
-- kterým se autentizuje jeho MCP klient (Cowork, Claude Desktop, Code…).
-- Ukládáme jen HASH (SHA-256), nikdy plaintext — po vytvoření se plain
-- ukáže jen jednou. Prefix (prvních 8 znaků) uchováme pro identifikaci
-- v seznamu.

CREATE TABLE IF NOT EXISTS user_mcp_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_prefix  TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON user_mcp_tokens(user_id);

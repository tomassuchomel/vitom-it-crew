-- Unread flag pro odpovědi na dotazy (from_user_id = asker).
-- Když někdo odpoví na dotaz, answer_read=FALSE. Když asker otevře
-- stránku "Odpovědi na dotazy", označíme všechny své answered za read.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_read BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_questions_answer_unread
  ON questions(from_user_id)
  WHERE status = 'answered' AND answer_read = FALSE;

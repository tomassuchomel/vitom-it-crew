-- Čas předání úkolu do review (in_progress → review). Pro férové skóre plnění:
-- "v termínu" se počítá podle PŘEDÁNÍ do review, ne podle pozdějšího schválení.
-- Fallback na completed_at u úkolů, které review workflow nepoužily.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_submitted_at TIMESTAMPTZ;

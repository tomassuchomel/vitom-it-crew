-- 2026-05-20: AI status timestamp + transition trigger
--
-- Bezpečnostní audit fixy:
--   H-4: ai_status_updated_at sloupec + trigger → detekce "stuck" tasků,
--        když worker spadl uprostřed práce. Recovery scanner v workeru
--        použije WHERE ai_status IN ('planning','implementing','in_review')
--                AND ai_status_updated_at < NOW() - INTERVAL '15 minutes'
--   C-2: BEFORE UPDATE trigger validuje OLD→NEW přechod přes allowlist.
--        Tím chytíme i mimo-aplikační UPDATE (admin SQL, bug v jiné cestě).
--
-- Idempotentní: CREATE OR REPLACE FUNCTION, ALTER TABLE ADD COLUMN IF NOT EXISTS.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_status_updated_at TIMESTAMPTZ;

-- Backfill pro existující řádky
UPDATE tasks SET ai_status_updated_at = COALESCE(created_at, NOW())
  WHERE ai_status_updated_at IS NULL;

-- ─── Funkce: validate transition + auto-update timestamp ───────────────────
CREATE OR REPLACE FUNCTION tasks_validate_ai_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  allowed_pairs TEXT[][] := ARRAY[
    -- idle
    ARRAY['idle', 'queued'],
    -- queued
    ARRAY['queued', 'planning'],
    ARRAY['queued', 'idle'],
    ARRAY['queued', 'failed'],
    -- planning
    ARRAY['planning', 'implementing'],
    ARRAY['planning', 'failed'],
    ARRAY['planning', 'needs_human'],
    ARRAY['planning', 'idle'],
    -- implementing
    ARRAY['implementing', 'in_review'],
    ARRAY['implementing', 'failed'],
    ARRAY['implementing', 'needs_human'],
    ARRAY['implementing', 'idle'],
    -- in_review (přidáno needs_human)
    ARRAY['in_review', 'done'],
    ARRAY['in_review', 'needs_changes'],
    ARRAY['in_review', 'needs_human'],
    ARRAY['in_review', 'failed'],
    ARRAY['in_review', 'idle'],
    -- needs_changes (přidáno queued)
    ARRAY['needs_changes', 'queued'],
    ARRAY['needs_changes', 'implementing'],
    ARRAY['needs_changes', 'failed'],
    ARRAY['needs_changes', 'idle'],
    -- done / failed / needs_human
    ARRAY['done', 'queued'],
    ARRAY['done', 'idle'],
    ARRAY['failed', 'queued'],
    ARRAY['failed', 'idle'],
    ARRAY['needs_human', 'queued'],
    ARRAY['needs_human', 'idle'],
    ARRAY['needs_human', 'failed']
  ];
  pair TEXT[];
  is_allowed BOOLEAN := FALSE;
BEGIN
  -- INSERT bez OLD – povoleny všechny počáteční stavy
  IF TG_OP = 'INSERT' THEN
    NEW.ai_status_updated_at := NOW();
    RETURN NEW;
  END IF;

  -- UPDATE bez změny stavu – jen propustit
  IF NEW.ai_status = OLD.ai_status THEN
    RETURN NEW;
  END IF;

  -- Validace OLD → NEW
  FOREACH pair SLICE 1 IN ARRAY allowed_pairs LOOP
    IF pair[1] = OLD.ai_status AND pair[2] = NEW.ai_status THEN
      is_allowed := TRUE;
      EXIT;
    END IF;
  END LOOP;

  IF NOT is_allowed THEN
    RAISE EXCEPTION 'invalid ai_status transition: % → % (task id=%)',
      OLD.ai_status, NEW.ai_status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Auto-update timestampu
  NEW.ai_status_updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Trigger ──────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tasks_ai_status_transition ON tasks;
CREATE TRIGGER tasks_ai_status_transition
  BEFORE INSERT OR UPDATE OF ai_status ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_validate_ai_status_transition();

-- Index pro recovery scanner
CREATE INDEX IF NOT EXISTS idx_tasks_stuck_ai
  ON tasks(ai_status_updated_at)
  WHERE ai_assignee = TRUE AND ai_status IN ('planning', 'implementing', 'in_review');

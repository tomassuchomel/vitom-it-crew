-- 2026-05-29: kresba (tužka) v poznámce
--
-- drawing = PNG export overlay canvasu (base64 data URL). Kreslí se „přes"
-- obsah poznámky. Uloženo jako TEXT (data URL), zobrazuje se jako overlay
-- vrstva nad textem i v read-only náhledu.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS drawing TEXT;

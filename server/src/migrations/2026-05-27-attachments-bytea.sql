-- 2026-05-27: Attachments persistence — soubory přímo v DB jako BYTEA
--
-- Důvod: Render free tier (a starter bez persistent disku) má ephemerální
-- filesystém. Po každém deploy/restartu se uploadované soubory v
-- server/data/uploads/ ztratí, ale DB záznamy zůstanou — výsledek: rozbité
-- obrázky v UI.
--
-- Řešení: ukládat samotná binární data do attachments.data (BYTEA), stejně
-- jako děláme s users.avatar_data. Soubor pak persistuje napříč deployi.
-- Limit per soubor zůstává 25 MB (multer fileSize limit).
--
-- Existující záznamy (před touto migrací) mají data IS NULL — soubory na
-- disku jsou (na produkci) už pryč. GET endpoint to vrátí 404. User si je
-- musí nahrát znovu; jiná možnost není (data jsou ztracená).

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS data BYTEA;

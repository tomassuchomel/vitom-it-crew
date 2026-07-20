-- MZV profil: socionický typ (16 socionics typů, 3-4 písm. kód).
-- Používá se manažerem k rychlé orientaci v silných/slabých stránkách +
-- komunikačním stylu podřízeného. AI insights se generují na tlačítko
-- v profilu (nekešujeme, dat je málo).

ALTER TABLE mzv_profiles
  ADD COLUMN IF NOT EXISTS socionics_type TEXT;

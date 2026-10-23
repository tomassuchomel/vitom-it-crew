-- PM Nápadníku může dostat právo schvalovat nápady, aniž by musel být
-- v týmu Management (členství v Managementu nese i další práva, která PM
-- Nápadníku mít nemá). Výchozí FALSE = dosavadní chování.

ALTER TABLE idea_pms
  ADD COLUMN IF NOT EXISTS can_approve_ideas BOOLEAN NOT NULL DEFAULT FALSE;

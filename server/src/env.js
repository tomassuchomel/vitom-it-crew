// Side-effect import: načti .env hned na začátku, dříve než cokoli jiného (db, auth, ai).
// override: true – chrání nás před prázdnou ANTHROPIC_API_KEY ze shellu (Claude Desktop apod.).
//
// POZOR: override znamená, že soubor .env PŘEBÍJÍ proměnné z prostředí.
// V produkci (VPS + systemd) .env existuje — leží v server/.env a zapisuje
// do něj Admin panel (routes/admin-server.js). Je tedy zdrojem pravdy, ne
// no-op, jak tu dřív stálo. Důsledek: poškozený nebo prázdný .env zahodí
// i hodnoty, které dodává systemd, a server nenastartuje. Proto se do něj
// zapisuje atomicky a hodnoty se před uložením validují.
import dotenv from 'dotenv';
dotenv.config({ override: true });

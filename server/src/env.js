// Side-effect import: načti .env hned na začátku, dříve než cokoli jiného (db, auth, ai).
// override: true – chrání nás před prázdnou ANTHROPIC_API_KEY ze shellu (Claude Desktop apod.).
// V produkci (Render) .env neexistuje a env injektuje runtime – override je no-op.
import dotenv from 'dotenv';
dotenv.config({ override: true });

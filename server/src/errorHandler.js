// Globální error handler Express aplikace.
//
// Je ve vlastním modulu, aby šel otestovat proti skutečné implementaci
// (ne proti kopii v testu) a aby ho index.js jen zapojil.
//
// Souvislost: index.js importuje 'express-async-errors', díky čemuž sem
// doputují i odmítnuté promisy z async handlerů. Bez toho by takový request
// visel bez odpovědi až do timeoutu.

import { recordError } from './errorBuffer.js';

// Databázové chyby, které jsou běžným uživatelským scénářem, ne poruchou —
// vracíme je jako srozumitelné 409, ne jako 500.
//   23503 = foreign_key_violation (smazat projekt, na kterém visí úkoly)
//   23505 = unique_violation (dvojklik na „přidat člena")
export const DB_ERROR_RESPONSES = {
  23503: { status: 409, error: 'in_use', message: 'Záznam nejde smazat, protože na něj navazují další data.' },
  23505: { status: 409, error: 'duplicate', message: 'Tenhle záznam už existuje.' },
};

export function errorHandler(err, req, res, next) {
  const known = DB_ERROR_RESPONSES[err?.code];
  const status = known ? known.status : 500;

  console.error('[api error]', err);
  recordError({
    source: 'api',
    message: err?.message,
    stack: err?.stack,
    path: req.originalUrl,
    status,
    userId: req.user?.id,
  });

  // Odpověď už mohla začít odcházet (např. stream přílohy) — pak ji nejde
  // přepsat, jen necháme Express spojení ukončit.
  if (res.headersSent) return next(err);

  if (known) return res.status(known.status).json({ error: known.error, message: known.message });
  res.status(500).json({ error: 'server_error', message: err?.message });
}

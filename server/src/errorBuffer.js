// In-memory ring buffer pro posledních N chyb serveru — přístupný v Admin UI.
// Používá se z index.js error handleru a middlewaru.
// Neukládáme do DB (chyby přijdou často, log rychle nakynul by, DB by trpěla).

const MAX = 100;
const buffer = [];

// Odstraní zjevné secrets z textu. Buffer je admin-only, ale nemá nést tokeny
// ani osobní data — kdokoli se dostane k Admin panelu (nebo screenshotu z něj)
// by je jinak viděl. Pár cílených regexů, ne univerzální DLP.
export function redact(text) {
  if (text == null) return text;
  let s = String(text);
  // 1) DB connection stringy: postgres://user:pass@host/db → postgres://***
  s = s.replace(/\b(postgres(?:ql)?:\/\/)[^\s'"<>]+/gi, '$1***');
  // 2) Authorization / Bearer: Authorization: Bearer abc  → Bearer ***
  //    Authorization chytáme až do konce řádku, ať nezůstane token za "Bearer".
  s = s.replace(/\bAuthorization\s*:[^\r\n]*/gi, 'Authorization: ***');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/\-]+=*/g, 'Bearer ***');
  // 3) Anthropic klíče
  s = s.replace(/\bsk-ant-[A-Za-z0-9_\-]+/g, '***');
  // 4) Dlouhé base64url / hex (≥24 znaků) — typicky JWT segmenty, API klíče,
  //    hash tokeny. Nezasáhne běžná slova; zasáhne i uvnitř URL query.
  s = s.replace(/[A-Za-z0-9_\-]{24,}/g, '***');
  return s;
}

// Ořízne query string z path — často nese tokeny (?code=…, ?token=…) i osobní
// data (?email=…). V UI stačí sama cesta.
function stripQuery(p) {
  if (!p) return p;
  const s = String(p);
  const i = s.indexOf('?');
  return i === -1 ? s : s.slice(0, i);
}

// Zaznamenaje chybu. Kompaktní — jen to, co uvidíme v UI.
export function recordError({ source, message, stack, path, status, userId }) {
  buffer.push({
    ts: new Date().toISOString(),
    source: source || 'unknown',
    message: redact(String(message || '')).slice(0, 500),
    stack: stack ? redact(String(stack)).slice(0, 2000) : null,
    path: stripQuery(path) || null,
    status: status || null,
    userId: userId || null,
  });
  // Ring buffer — starší se odsouvají.
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

// Seznam nejnovějších chyb (v UI se ukazuje nejnovější první).
export function getRecentErrors(limit = 50) {
  return buffer.slice(-limit).reverse();
}

export function clearErrors() {
  buffer.length = 0;
}

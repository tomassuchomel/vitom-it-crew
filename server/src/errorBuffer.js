// In-memory ring buffer pro posledních N chyb serveru — přístupný v Admin UI.
// Používá se z index.js error handleru a middlewaru.
// Neukládáme do DB (chyby přijdou často, log rychle nakynul by, DB by trpěla).

const MAX = 100;
const buffer = [];

// Zaznamenaje chybu. Kompaktní — jen to, co uvidíme v UI.
export function recordError({ source, message, stack, path, status, userId }) {
  buffer.push({
    ts: new Date().toISOString(),
    source: source || 'unknown',
    message: String(message || '').slice(0, 500),
    stack: stack ? String(stack).slice(0, 2000) : null,
    path: path || null,
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

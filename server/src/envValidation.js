// Validace hodnot env proměnných měnitelných z Admin panelu.
//
// Proč vůbec: soubor .env je přes dotenv override autoritou nad systemd
// (viz env.js), takže překlep v hodnotě se projeví až při příštím startu —
// a to může být za týdny, kdy už nikdo neví, co se měnilo. Lepší odmítnout
// hned při ukládání.
//
// Vlastní modul kvůli testovatelnosti; používá ho routes/admin-server.js.

// Klíče, u kterých špatná hodnota rozbije běh aplikace.
const VALIDATORS = {
  NODE_ENV: (v) => (['production', 'development', 'test'].includes(v)
    ? null
    : 'NODE_ENV smí být jen production, development nebo test.'),

  DATABASE_SSL: (v) => (['true', 'false'].includes(v.toLowerCase())
    ? null
    : 'DATABASE_SSL smí být jen true nebo false.'),

  CLIENT_URL: urlValidator('CLIENT_URL'),
  APP_BASE_URL: urlValidator('APP_BASE_URL'),
};

function urlValidator(name) {
  return (v) => {
    try {
      const u = new URL(v);
      if (!['http:', 'https:'].includes(u.protocol)) {
        return `${name} musí začínat http:// nebo https://.`;
      }
      return null;
    } catch {
      return `${name} není platná adresa (očekávám např. https://it.realitniekosystem.cz).`;
    }
  };
}

// Vrací chybovou hlášku, nebo null když je hodnota v pořádku.
// Klíče bez validátoru propouštíme — nejsou kritické pro běh.
export function validateEnvValue(key, value) {
  const check = VALIDATORS[key];
  if (!check) return null;
  const v = String(value ?? '').trim();
  if (!v) return `${key} nesmí být prázdné.`;
  return check(v);
}

export const VALIDATED_KEYS = Object.keys(VALIDATORS);

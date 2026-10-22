// Validace hodnot env proměnných měnitelných z Admin panelu.
//
// .env přebíjí systemd (env.js, dotenv override), takže překlep v hodnotě
// se projeví až při příštím startu — klidně za týdny. Proto se odmítá hned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvValue } from '../envValidation.js';

test('NODE_ENV: platné hodnoty projdou, cokoli jiného ne', () => {
  assert.equal(validateEnvValue('NODE_ENV', 'production'), null);
  assert.equal(validateEnvValue('NODE_ENV', 'development'), null);

  // Překlep by v produkci vypnul servírování frontendu.
  assert.match(validateEnvValue('NODE_ENV', 'produciton'), /production/);
  assert.ok(validateEnvValue('NODE_ENV', 'prod'));
});

test('DATABASE_SSL: jen true/false', () => {
  assert.equal(validateEnvValue('DATABASE_SSL', 'true'), null);
  assert.equal(validateEnvValue('DATABASE_SSL', 'FALSE'), null, 'velikost písmen nerozhoduje');
  assert.ok(validateEnvValue('DATABASE_SSL', 'ano'));
  assert.ok(validateEnvValue('DATABASE_SSL', '1'));
});

test('adresy musí být platné URL s http(s)', () => {
  assert.equal(validateEnvValue('CLIENT_URL', 'https://it.realitniekosystem.cz'), null);
  assert.equal(validateEnvValue('APP_BASE_URL', 'http://localhost:5173'), null);

  assert.match(validateEnvValue('CLIENT_URL', 'it.realitniekosystem.cz'), /platná adresa/);
  assert.match(validateEnvValue('APP_BASE_URL', 'ftp://server'), /http/);
  assert.ok(validateEnvValue('CLIENT_URL', 'https://'), 'samotné schéma nestačí');
});

test('prázdná hodnota u hlídaného klíče neprojde', () => {
  assert.match(validateEnvValue('NODE_ENV', ''), /prázdné/);
  assert.match(validateEnvValue('CLIENT_URL', '   '), /prázdné/);
});

test('nehlídané klíče propouštíme beze změny', () => {
  assert.equal(validateEnvValue('ANTHROPIC_API_KEY', 'sk-ant-cokoliv'), null);
  assert.equal(validateEnvValue('MAIL_M365_MAILBOX', 'notifikace@vitom.cz'), null);
  assert.equal(validateEnvValue('NEZNAMY_KLIC', ''), null, 'prázdno jen u hlídaných klíčů');
});

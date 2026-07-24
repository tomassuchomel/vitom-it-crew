// formatEnvValue: dotenv double-quoted round-trip pro hodnoty se speciálními znaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEnvValue } from '../admin-server.js';

test('bez speciálních znaků → bez uvozovek', () => {
  assert.equal(formatEnvValue('production'), 'production');
  assert.equal(formatEnvValue('sk-abc123'), 'sk-abc123');
  assert.equal(formatEnvValue('4000'), '4000');
});

test('prázdná hodnota → prázdný string', () => {
  assert.equal(formatEnvValue(''), '');
  assert.equal(formatEnvValue(null), '');
  assert.equal(formatEnvValue(undefined), '');
});

test('mezera / # / = → uvozovky', () => {
  assert.equal(formatEnvValue('hello world'), '"hello world"');
  assert.equal(formatEnvValue('key#comment'), '"key#comment"');
  assert.equal(formatEnvValue('a=b'), '"a=b"');
});

test('leading/trailing whitespace → uvozovky', () => {
  assert.equal(formatEnvValue(' spaced'), '" spaced"');
  assert.equal(formatEnvValue('trail '), '"trail "');
});

test('uvozovky uvnitř quotujeme a escapujeme', () => {
  assert.equal(formatEnvValue('with "quote"'), '"with \\"quote\\""');
});

test('round-trip skrz dotenv-like parser: uvozovky sundáme, escape rozvinout', () => {
  // Minimální parser: no-quote větev vrací as-is, double-quoted rozpakuje \" a \\.
  const parse = (raw) => {
    const m = raw.match(/^"(.*)"$/s);
    if (!m) return raw;
    return m[1].replace(/\\\\/g, '\x00').replace(/\\"/g, '"').replace(/\x00/g, '\\');
  };
  for (const v of ['plain', 'hello world', 'a=b', 'trail ', 'has "q"', 'back\\s']) {
    assert.equal(parse(formatEnvValue(v)), v, `round-trip selhal pro: ${JSON.stringify(v)}`);
  }
});

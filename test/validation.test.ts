import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argumentError, COMPILED_MAX } from '../src/validation.ts';
test('validate provider drafts without coercion, defaults, remote refs, or skipped formats', () => {
  for (const $schema of [undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema']) {
    const schema = { ...($schema ? { $schema } : {}), type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } };
    assert.equal(argumentError(schema, { email: 'a@example.com' }), null);
    assert.match(argumentError(schema, { email: 'bad' })!, /arguments/);
    assert.match(argumentError(schema, {})!, /required/);
  }
  assert.match(argumentError({ $schema: 'https://invalid/schema' }, {})!, /unsupported/);
  assert.match(argumentError({ $ref: 'https://remote.test/schema' }, {})!, /unsupported/);
});

test('the same schema is compiled once, and the store of compiled checks stays bounded', () => {
  const schema = () => ({ type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] });
  for (let i = 0; i < 3; i++) {
    assert.equal(argumentError(schema(), { n: 1 }), null);
    assert.match(argumentError(schema(), { n: 'x' })!, /integer/);
  }
  // Past the limit everything compiled is dropped and checks still work.
  for (let i = 0; i <= COMPILED_MAX; i++) assert.equal(argumentError({ type: 'object', properties: { [`k${i}`]: { type: 'string' } } }, {}), null);
  assert.match(argumentError(schema(), {})!, /required/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { argumentError } from '../src/validation.ts';
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

test('defaults to 127.0.0.1:8787', () => {
  assert.deepEqual(loadConfig({}), { host: '127.0.0.1', port: 8787 });
});

test('accepts other local hosts and a port, trimming spaces', () => {
  assert.deepEqual(loadConfig({ HOST: ' localhost ', PORT: ' 9000 ' }), { host: 'localhost', port: 9000 });
  assert.deepEqual(loadConfig({ HOST: '::1', PORT: '0' }), { host: '::1', port: 0 });
  assert.deepEqual(loadConfig({ HOST: '', PORT: '' }), { host: '127.0.0.1', port: 8787 });
});

test('refuses to listen beyond this machine', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /HOST must be a local address.*"0\.0\.0\.0"/);
});

test('rejects a bad port', () => {
  for (const PORT of ['abc', '70000', '-1', '1.5']) {
    assert.throws(() => loadConfig({ PORT }), new RegExp(`PORT must be an integer.*"${PORT.replace('.', '\\.')}"`));
  }
});

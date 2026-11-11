import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalBrowser } from '../src/browser.ts';
import { mock, sendJson } from './helpers.ts';

test('a dedicated browser navigates, reads, fills, clicks once, and verifies resulting state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-browser-'));
  const page = await mock((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Test</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>'); });
  const browser = new LocalBrowser(dir, true);
  try {
    await assert.rejects(browser.run({ operation: 'navigate', url: page.url }), /enable/i);
    browser.enabled = true;
    await assert.rejects(browser.run({ operation: 'unknown' }), /Unknown/);
    await assert.rejects(browser.run({ operation: 'navigate', url: 'file:///etc/passwd' }), /http/i);
    const first = await browser.run({ operation: 'navigate', url: page.url });
    assert.equal(first.title, 'Test');
    await assert.rejects(browser.run({ operation: 'click' }), /selector/);
    await assert.rejects(browser.run({ operation: 'click', selector: '' }), /selector/);
    await assert.rejects(browser.run({ operation: 'fill', selector: '#name', text: 123 }), /string/);
    await browser.run({ operation: 'fill', selector: '#name', text: 'nonce-123' });
    assert.match((await browser.run({ operation: 'inspect' })).snapshot, /Name/);
    const saved = await browser.run({ operation: 'click', selector: 'button' });
    assert.match(saved.snapshot, /nonce-123/);
    await assert.rejects(browser.run({ operation: 'click', selector: '.missing' }), /Timeout/);
    browser.enabled = false;
    await assert.rejects(browser.run({ operation: 'inspect' }), /enable/i);
  } finally { await browser.close(); await page.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing the browser tab does not leave the next command using a dead page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-browser-tab-'));
  const browser = new LocalBrowser(dir, true);
  browser.enabled = true;
  try {
    await browser.run({ operation: 'inspect' });
    const context = (browser as any).context;
    await context.pages()[0].close();
    const next = await browser.run({ operation: 'inspect' });
    assert.equal(next.url, 'about:blank');
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

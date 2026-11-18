// End-to-end check of the meeting features in the browser version, with no account traffic: the real page and call
// engine run in headless Chromium against stubbed /api routes and fake xAI voice sessions whose bots answer what
// the call asks of them (vote when it is their turn, tell the result, save a summary, otherwise pass).
//
//   CHROME_PATH=/path/to/chrome node scripts/verify-meeting-page.ts [screenshot-dir]
//
// Without CHROME_PATH, Playwright's own Chromium is used. Exits non-zero on the first failed check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { WebSocketServer, type WebSocket } from 'ws';

const ROOT = path.join(import.meta.dirname, '..', 'public');
const OUT = process.argv[2] ?? '';
const USER = 'Shashank';
const BOTS = [
  { id: 'a', name: 'Nova', voice: null, speed: 1, language: null, color: null, shape: null },
  { id: 'b', name: 'Orbit', voice: null, speed: 1, language: null, color: null, shape: null },
  { id: 'c', name: 'Quill', voice: null, speed: 1, language: null, color: null, shape: null },
];
const checks: string[] = [];
const check = (name: string) => {
  checks.push(name);
  console.log(`ok - ${name}`);
};

// ---------- fake voice sessions ----------

/** What each bot's session was told: its latest instructions and every message it was given. */
const sessions = new Map<string, { instructions: string; said: string[] }>();

function fakeBot(ws: WebSocket, id: string) {
  const s = { instructions: '', said: [] as string[] };
  sessions.set(id, s);
  let ready = false;
  let n = 0;
  const send = (e: object) => ws.send(JSON.stringify(e));
  const reply = (transcript: string, tool?: { name: string; args: object }) =>
    setTimeout(() => {
      const rid = `r-${id}-${++n}`;
      send({ type: 'response.created', response: { id: rid } });
      send({ type: 'response.output_item.added', item: { id: `item-${rid}` } });
      if (transcript) send({ type: 'response.output_audio_transcript.done', transcript });
      if (tool) send({ type: 'response.function_call_arguments.done', call_id: `call-${rid}`, name: tool.name, arguments: JSON.stringify(tool.args) });
      send({ type: 'response.done', response: { status: 'completed' } });
    }, 40);
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'session.update') {
      if (typeof m.session?.instructions === 'string') s.instructions = m.session.instructions;
      if (!ready) {
        ready = true;
        send({ type: 'conversation.created', conversation: { id: `conv-${id}` } });
        send({ type: 'session.updated' });
      }
    } else if (m.type === 'conversation.item.create' && m.item?.type === 'message') {
      s.said.push(m.item.content[0].text);
    } else if (m.type === 'response.create') {
      const last = s.said.at(-1) ?? '';
      if (/ending this group voice call/.test(m.response?.instructions ?? '')) {
        reply('', { name: 'save_summary', args: { summary: 'We set the agenda, voted on the name and recorded the price.', action_items: ['Email the beta list'] } });
      } else if (last.startsWith('[Poll]: Your turn to vote')) {
        const options = /Options: (.*?)\. Use cast_vote/.exec(last)![1].split('; ');
        const pick = id === 'c' ? options[1] : options[0];
        reply(`${pick}, because it is easy to say.`, { name: 'cast_vote', args: { option: pick, reason: 'easy to say' } });
      } else if (last.startsWith('[Poll]: Tell')) {
        reply(`The vote is in: ${/Winner: (.*?)\./.exec(last)?.[1] ?? 'a tie'} wins.`);
      } else if (last.includes('just joined')) {
        reply(`Hi ${USER}, ready when you are.`);
      } else {
        reply('', { name: 'pass', args: {} }); // nothing to add
      }
    }
  });
}

// ---------- the page's server, with stubbed account routes ----------

const saved: { memory: any; markdown: string }[] = [];
const toolCalls: any[] = [];

async function startServers(): Promise<{ url: string; close: () => void }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => [...p][0] });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws, req) => fakeBot(ws, req.url!.slice(1)));
  const wsPort = (wss.address() as AddressInfo).port;
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer(async (req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      let text = '';
      for await (const chunk of req) text += chunk;
      return text ? JSON.parse(text) : null;
    };
    const url = req.url!.split('?')[0];
    const voice = /^\/api\/bots\/(\w+)\/(voice|tool|landed)$/.exec(url);
    if (url === '/api/state') return json({ state: 'signed-in' });
    if (url === '/api/bots') return json({ bots: BOTS });
    if (url === '/api/memory') return json({ memory: { summary: 'We picked May for the launch.', actionItems: [], notes: [], decisions: ['Launch in May'] } });
    if (url === '/api/calls') {
      saved.push(await body());
      return json({ file: 'calls/call-test.md' });
    }
    if (voice?.[2] === 'voice') {
      const bot = BOTS.find((b) => b.id === voice[1])!;
      return json({
        clientSecret: 'secret', url: `ws://127.0.0.1:${wsPort}/${bot.id}`, instructions: `You are ${bot.name}.`, apps: [],
        tools: [{ type: 'function', name: 'search_past_calls', description: 'Search saved calls.', parameters: { type: 'object', properties: {} } }],
      });
    }
    if (voice?.[2] === 'tool') {
      toolCalls.push(await body());
      return json({ kind: 'served', output: { matches: [] } });
    }
    if (voice?.[2] === 'landed') return json({ work: [] });
    const file = url === '/' ? 'index.html' : url.slice(1);
    if (!/^(index\.html|app\.js|core\.js)$/.test(file)) {
      res.writeHead(404);
      return res.end();
    }
    let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (file === 'core.js') text = text.replace(/^export const USER = .*$/m, `export const USER = ${JSON.stringify(USER)};`);
    res.writeHead(200, { 'content-type': `${types[path.extname(file)]}; charset=utf-8` });
    res.end(text);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/#t=test`, close: () => (server.close(), wss.close()) });
    });
  });
}

// ---------- the checks ----------

const text = (page: Page, sel: string) => page.locator(sel).innerText();
const until = (page: Page, fn: () => boolean) => page.waitForFunction(fn, null, { timeout: 15_000 });

async function shot(page: Page, name: string) {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

async function main() {
  const { url, close } = await startServers();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);

    // Lobby: pick every bot and write an agenda.
    await page.locator('#lobby:not([hidden])').waitFor();
    assert.equal(await page.locator('#memory-hint').isVisible(), true);
    assert.match(await text(page, '#memory-hint'), /decisions/);
    for (const b of BOTS) await page.locator('.pick', { hasText: b.name }).click();
    await page.locator('#agenda-box > summary').click();
    await page.locator('#lobby-agenda').fill('Pick a name (5 min)\nPricing (10 min)\nWrap up');
    await shot(page, '1-lobby-agenda');
    check('lobby: the agenda box takes one topic per line');
    await page.locator('#join').click();
    await page.locator('#call:not([hidden])').waitFor();

    // Every bot joins with the agenda, the meeting rules and the last call's decisions.
    await until(page, () => document.querySelectorAll('.tile:not(.you)').length === 3);
    await page.waitForTimeout(400);
    for (const id of ['a', 'b', 'c']) {
      const ins = sessions.get(id)!.instructions;
      assert.match(ins, /# Agenda\n1\. Pick a name, 5 min \(now\)\n2\. Pricing, 10 min\n3\. Wrap up/);
      assert.match(ins, /# Decided in earlier calls\n- Launch in May/);
      assert.match(ins, /search_past_calls searches Shashank's saved calls/);
    }
    check('join: each bot\'s instructions carry the agenda, the earlier decisions and the past-call search');

    // The Meeting panel shows the agenda with the current topic.
    await page.locator('#tasks-btn').click();
    await page.locator('#tasks:not([hidden])').waitFor();
    assert.equal(await text(page, '#tasks h2'), 'Meeting');
    const first = page.locator('#agenda-list li').first();
    assert.match(await first.innerText(), /1\. Pick a name\s+Now · 0 of 5 min/);
    assert.equal(await first.getAttribute('class'), 'current');
    assert.equal(await page.locator('#agenda-list li').count(), 3);
    check('panel: the agenda lists every topic and marks the current one with its time');

    // A vote from the panel: each bot votes in turn through the call engine, then one says the result.
    await page.locator('#poll-edit > summary').click();
    await page.locator('#poll-question').fill('What should we call the app?');
    await page.locator('#poll-options').fill('Lumen or Beacon');
    await page.locator('#poll-form button').click();
    await page.locator('#poll-open:not([hidden])').waitFor();
    await shot(page, '2-voting');
    await until(page, () => document.querySelectorAll('#poll-list li').length === 1);
    const result = await text(page, '#poll-list li');
    assert.match(result, /"What should we call the app\?": Lumen 2 \(Nova, Orbit\), Beacon 1 \(Quill\)\. Winner: Lumen\./);
    assert.equal(await page.locator('#poll-open').isHidden(), true);
    for (const id of ['a', 'b', 'c']) assert.ok(sessions.get(id)!.said.some((t) => t.startsWith('[Poll]: Your turn to vote')), `bot ${id} was asked for its vote`);
    await page.waitForTimeout(300);
    assert.ok(sessions.get('a')!.said.some((t) => t.startsWith('[Poll]: Tell Shashank the result')), 'the first bot was asked to say the result');
    check('vote: started from the panel, every bot voted in turn, the tally is shown and a bot tells the result');

    // A decision from the panel reaches every bot.
    await page.locator('#decision-text').fill('Price is five dollars a month');
    await page.locator('#decision-form button').click();
    await until(page, () => document.querySelectorAll('#decision-list li').length === 1);
    assert.match(await text(page, '#decision-list li'), /1\. Price is five dollars a month\s+Shashank · \d+:\d\d/);
    for (const id of ['a', 'b', 'c']) assert.ok(sessions.get(id)!.said.includes('[Decisions]: Shashank recorded decision 1: "Price is five dollars a month"'));
    await page.waitForTimeout(200);
    assert.match(sessions.get('b')!.instructions, /# Decided in this call\n1\. Price is five dollars a month/);
    check('decision: recorded from the panel, told to every bot and pinned in their instructions');

    // Next topic with an outcome.
    await page.locator('#topic-outcome').fill('Lumen');
    await page.locator('#next-topic button').click();
    await until(page, () => document.querySelector('#agenda-list li')?.className === 'done');
    assert.match(await text(page, '#agenda-list li:nth-child(1)'), /Done: Lumen/);
    assert.match(await text(page, '#agenda-list li:nth-child(2)'), /Now · 0 of 10 min/);
    assert.ok(sessions.get('a')!.said.includes('[Agenda]: Shashank closed topic 1, "Pick a name": Lumen. Next topic: "Pricing".'));
    await shot(page, '3-meeting-panel');
    check('agenda: "Next topic" closes the topic with its outcome and opens the next');

    // Refusals from the panel are shown, not swallowed.
    await page.locator('#decision-text').fill('price is five dollars a month!');
    await page.locator('#decision-form button').click();
    await until(page, () => document.querySelector('#toast')?.textContent === 'That decision is already recorded.');
    check('panel: a duplicate decision is refused with the reason');

    // Narrow screens: the panel fits with no sideways scroll.
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, `no horizontal scroll at ${width}px`);
      const box = (await page.locator('#tasks').boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width, `the panel fits at ${width}px`);
    }
    await shot(page, '4-phone');
    await page.setViewportSize({ width: 1280, height: 860 });
    check('layout: the Meeting panel fits at 375 px and 320 px wide');

    // Leave: the summary is saved with the agenda, decisions, votes and who talked.
    await page.locator('#tasks-close').click();
    await page.locator('#leave').click();
    await page.locator('#saved:not([hidden])').waitFor({ timeout: 25_000 });
    await until(page, () => /Saved to/.test(document.querySelector('#saved-where')?.textContent ?? ''));
    assert.match(await text(page, '#saved-decisions'), /Price is five dollars a month/);
    const [call] = saved;
    assert.deepEqual(call.memory.decisions, ['Launch in May', 'Price is five dollars a month']);
    for (const section of ['## Agenda', '## Decisions', '## Polls', '## Who talked']) assert.ok(call.markdown.includes(section), section);
    assert.match(call.markdown, /- \[x\] Pick a name \(planned 5 min, took (under )?1 min\): Lumen/);
    assert.match(call.markdown, /- \[ \] Pricing \(planned 10 min, in progress at the end\)/);
    assert.match(call.markdown, /- \[ \] Wrap up \(not reached\)/);
    assert.match(call.markdown, /  - Quill: Beacon, because easy to say/);
    assert.match(call.markdown, /## Summary\n\nWe set the agenda, voted on the name and recorded the price\./);
    await shot(page, '5-saved');
    check('leave: the saved call has the agenda, decisions, votes and who talked, and memory keeps the decisions');

    assert.deepEqual(errors, [], 'no page errors');
    check('no page errors');
    if (OUT) fs.writeFileSync(path.join(OUT, 'saved-call.md'), call.markdown);
  } finally {
    await browser.close();
    close();
  }
  console.log(`\n${checks.length} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

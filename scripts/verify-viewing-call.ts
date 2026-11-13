// Opt-in live voice acceptance check. Uses synthetic page results; never opens or operates a browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { AuthStore } from '../src/auth.ts';
import { GrokBotClient } from '../src/grokbot.ts';
import { LOCAL_TOOLS } from '../src/local-tools.ts';
import { OverlayCall } from '../src/overlay/call.ts';

const dataDir = path.join(process.env.HOME!, 'Library/Application Support/GrokCall');
const client = new GrokBotClient({ store: new AuthStore(dataDir), setupTimeoutMs: 30000 });
const bots = await client.listBots();
const bot = bots.find((b) => b.name === "Shashank's Bot") ?? bots[0];
assert.ok(bot, 'A signed-in bot is required');
const reads: Record<string, unknown>[] = [];
const responses: string[] = [];
const forbidden: string[] = [];
let selected = false;
const phrase = 'cobalt orchard nine';
async function until(predicate: () => boolean, ms = 45000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Live viewing acceptance test timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const call = new OverlayCall({
  mintVoice: async (id: string) => {
    const voice = await client.voiceSession(id);
    return { ...voice, tools: [...voice.tools, ...LOCAL_TOOLS] };
  },
  openSocket: (url: string, protocols: string[]) => new WebSocket(url, protocols),
  callTool: async (_id: string, req: any) => {
    if (req.name !== 'mac_observe') {
      // Ending the synthetic call must not send a real background job.
      if (!String(req.input?.request).includes('The call ended')) forbidden.push(req.name);
      return { kind: 'invalid_input', output: { error: 'This verification permits mac_observe only.' } };
    }
    reads.push(req.input);
    return { kind: 'served', output: selected
      ? { status: 'captured', window: { id: 42, app: 'Zen', title: 'YouTube' }, capturedAt: new Date().toISOString(), text: `Verification phrase: ${phrase}`, note: 'Fresh OCR from the requested page. This result contains text only, not visual interpretation.' }
      : { status: 'not_found', note: 'I could not read the requested YouTube page. Ask the user to select that tab in their existing Zen window and tell you when it is ready, then take a fresh read. Do not open browsers or switch tabs yourself.' } };
  },
  audio: { now: () => performance.now() / 1000, play: () => ({ stop() {} }) },
  setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (t: any) => clearTimeout(t), now: Date.now,
});
const event = call.event.bind(call);
call.event = (kind: string, text: string) => { event(kind, text); if (kind === 'bot') responses.push(text); };
try {
  call.joinWith([bot], bots, null);
  await until(() => {
    const link = call.links.get(bot.id);
    if (link?.status === 'error') throw new Error(link.error);
    return link?.ready === true;
  });
  const first = responses.length;
  call.sendText('Can you see YouTube in Zen? Please check the page itself.');
  await until(() => reads.length > 0 && responses.length > first && !call.links.get(bot.id).active && !call.links.get(bot.id).pending);
  const fallback = responses.slice(first).join(' ');
  assert.match(fallback, /select|open|bring|switch|visible|pull up/i, 'The answer must give the user a next step');
  assert.match(fallback, /Zen|YouTube/i);
  const before = reads.length;
  selected = true;
  const second = responses.length;
  call.sendText("I've selected YouTube in my existing Zen window. It's ready now. Please read the verification phrase on the page.");
  await until(() => reads.length > before && responses.length > second && !call.links.get(bot.id).active && !call.links.get(bot.id).pending);
  const answer = responses.slice(second).join(' ');
  assert.match(answer, /cobalt[\s,]+orchard[\s,]+nine/i, 'The answer must come from the fresh tool result');
  assert.deepEqual(forbidden, [], 'No browser or agent fallback may be attempted');
  const report = { passed: true, scope: 'Real voice endpoint with synthetic page results; not a native screen-capture or UI test', bot: bot.name, reads, fallback, answer, forbidden };
  const dir = new URL('../docs/verification/background-viewing/', import.meta.url);
  fs.writeFileSync(new URL('live-voice-fallback.json', dir), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { call.leave(); }

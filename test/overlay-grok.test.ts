import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AuthStore } from '../src/auth.ts';
import {
  BadSetting,
  COLORS,
  LANGUAGES,
  OverlayGrokClient,
  parseNewBot,
  parseVoiceSettings,
  PICKER_SHAPES,
  SHAPES,
  SPEEDS,
  VOICES,
} from '../src/overlay/grok.ts';
import { mock, sendJson } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-ov-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const agent = (id: string, extra: object = {}) => ({ id, name: `Bot ${id}`, kind: 'GROK_BOT_AGENT_KIND_AGENT', avatarShape: 'blob', avatarColor: 'blue', ...extra });

/** A fake Grok Bot: records calls; `create` answers CreateGrokBotTemporalAgent. */
async function fake(create: (body: any) => [number, unknown] = (b) => [200, { agent: { id: 'new', agentId: b.agentId } }]) {
  const agents = [agent('1')];
  const up = await mock((req, res) => {
    const method = req.url.split('/').pop();
    if (method === 'ListGrokBotAgents') return sendJson(res, 200, { agents });
    if (method === 'SetGrokBotAgentVoice') {
      const a = agents.find((x) => x.id === req.body.id) as any;
      if (!a) return sendJson(res, 404, { message: 'no agent' });
      Object.assign(a, req.body.voiceId === undefined ? {} : { voiceId: req.body.voiceId }, req.body.voiceSpeed === undefined ? {} : { voiceSpeed: req.body.voiceSpeed }, req.body.voiceLanguage === undefined ? {} : { voiceLanguage: req.body.voiceLanguage });
      return sendJson(res, 200, { agent: a });
    }
    if (method === 'CreateGrokBotTemporalAgent') {
      const [s, body] = create(req.body);
      if (s === 200 && (body as any)?.agent?.id === 'new') agents.push(agent('new', { name: req.body.name }));
      return sendJson(res, s, body);
    }
    sendJson(res, 404, { message: `unknown ${method}` });
  });
  const dir = fs.mkdtempSync(path.join(tmp, 'd'));
  const store = new AuthStore(dir);
  store.write({ accessToken: 'tok', refreshToken: null, machineId: 'mid' });
  return { up, agents, client: new OverlayGrokClient({ store, apiUrl: up.url }) };
}

test('choice lists match the Grok Bot app', () => {
  assert.equal(VOICES.length, 28);
  assert.deepEqual([...SPEEDS], [0.5, 0.75, 1, 1.25, 1.5, 2]);
  assert.equal(LANGUAGES.length, 28);
  assert.equal(SHAPES.length, 25);
  for (const s of PICKER_SHAPES) assert.ok(SHAPES.includes(s));
  assert.equal(Object.keys(COLORS).length, 11);
});

test('parseVoiceSettings keeps only the fields given', () => {
  assert.deepEqual(parseVoiceSettings({ voice: 'carina' }), { voice: 'carina' });
  assert.deepEqual(parseVoiceSettings({ voice: null, speed: 1.5, language: null }), { voice: null, speed: 1.5, language: null });
  assert.deepEqual(parseVoiceSettings({ language: 'hi' }), { language: 'hi' });
});

test('parseVoiceSettings refuses bad values with the reason', () => {
  const bad: [unknown, RegExp][] = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{}, /nothing to change/],
    [{ voice: 'bob' }, /voice must be one of altair/],
    [{ speed: 3 }, /speed must be one of 0.5/],
    [{ language: 'xx' }, /language must be a supported/],
  ];
  for (const [raw, why] of bad) assert.throws(() => parseVoiceSettings(raw), (e) => e instanceof BadSetting && why.test(e.message));
});

test('parseNewBot cleans text and checks look and voice', () => {
  const ok = { name: '  Research\nbot ', description: ' Finds things ', shape: 'star', color: 'violet' };
  assert.deepEqual(parseNewBot(ok), { name: 'Research bot', description: 'Finds things', shape: 'star', color: 'violet', voice: null });
  assert.equal(parseNewBot({ ...ok, voice: 'eve', description: undefined }).voice, 'eve');
  const bad: [unknown, RegExp][] = [
    [null, /must be an object/],
    [[], /must be an object/],
    [{ ...ok, name: ' ' }, /name is required/],
    [{ ...ok, name: 5 }, /name is required/],
    [{ ...ok, name: 'x'.repeat(61) }, /name is longer than 60/],
    [{ ...ok, description: 'x'.repeat(501) }, /description is longer than 500/],
    [{ ...ok, shape: 'moon' }, /shape must be one of/],
    [{ ...ok, color: 'pink' }, /color must be one of black/],
    [{ ...ok, color: 'toString' }, /color must be one of/],
    [{ ...ok, voice: 'bob' }, /voice must be one of Grok's voices/],
  ];
  for (const [raw, why] of bad) assert.throws(() => parseNewBot(raw), (e) => e instanceof BadSetting && why.test(e.message), String(why));
});

test('setVoice sends only the changed fields, maps null to the default, and returns the fresh bot', async () => {
  const { up, client } = await fake();
  try {
    const bot = await client.setVoice('1', { voice: 'carina', speed: 1.5, language: 'hi' });
    assert.deepEqual([bot.voice, bot.speed, bot.language], ['carina', 1.5, 'hi']);
    assert.deepEqual(up.requests.find((r) => r.url.endsWith('SetGrokBotAgentVoice'))!.body, { id: '1', voiceId: 'carina', voiceSpeed: 1.5, voiceLanguage: 'hi' });
    const back = await client.setVoice('1', { voice: null, language: null });
    assert.deepEqual([back.voice, back.speed, back.language], [null, 1.5, null]);
    assert.deepEqual(up.requests.filter((r) => r.url.endsWith('SetGrokBotAgentVoice'))[1].body, { id: '1', voiceId: '', voiceLanguage: 'auto' });
    await assert.rejects(client.setVoice('9', { speed: 1 }), /SetGrokBotAgentVoice failed \(HTTP 404: no agent\)/);
  } finally {
    await up.close();
  }
});

test('createBot asks for a Temporal bot like the Grok Bot app, then sets the voice', async () => {
  const { up, client } = await fake();
  try {
    const bot = await client.createBot({ name: 'Researcher', description: 'Finds things', shape: 'star', color: 'violet', voice: 'eve' });
    assert.equal(bot.id, 'new');
    assert.equal(bot.voice, 'eve');
    const body = up.requests.find((r) => r.url.endsWith('CreateGrokBotTemporalAgent'))!.body;
    assert.match(body.agentId, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ...body, agentId: 'x' }, {
      agentId: 'x', name: 'Researcher', description: 'Finds things', title: '', avatarShape: 'star', avatarColor: 'violet',
      harness: 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL', kickstartRequested: false, introductionSuppressed: true,
    });
  } finally {
    await up.close();
  }
});

test('createBot without a voice skips the voice call', async () => {
  const { up, client } = await fake();
  try {
    await client.createBot({ name: 'Plain', description: '', shape: 'blob', color: 'gray' });
    assert.ok(!up.requests.some((r) => r.url.endsWith('SetGrokBotAgentVoice')));
  } finally {
    await up.close();
  }
});

test('createBot reports a missing bot instead of guessing', async () => {
  for (const reply of [{}, { agent: {} }, { agent: { id: 5 } }]) {
    const { up, client } = await fake(() => [200, reply]);
    try {
      await assert.rejects(client.createBot({ name: 'x', description: '', shape: 'blob', color: 'gray' }), /did not return the new bot/);
    } finally {
      await up.close();
    }
  }
  const { up, client } = await fake(() => [200, { agent: { id: 'ghost' } }]);
  try {
    await assert.rejects(client.createBot({ name: 'x', description: '', shape: 'blob', color: 'gray' }), /not in your bot list/);
  } finally {
    await up.close();
  }
});

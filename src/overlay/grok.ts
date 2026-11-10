import crypto from 'node:crypto';
import { type Bot, GrokBotClient } from '../grokbot.ts';

// Choices offered by the Grok Bot app (v0.79.3) for a bot's voice and look.

export const VOICES = [
  'altair', 'ara', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo', 'eve', 'helios', 'helix', 'iris', 'kepler', 'leo',
  'liora', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rex', 'rigel', 'sal', 'sirius', 'ursa', 'zagan', 'zenith',
] as const;
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const LANGUAGES = [
  'en', 'ar-EG', 'ar-SA', 'ar-AE', 'bn', 'ca', 'zh', 'da', 'nl', 'fi', 'fr', 'de', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'pl', 'pt-BR',
  'pt-PT', 'ru', 'es-MX', 'es-ES', 'sv', 'th', 'tr', 'vi',
] as const;
/** Every shape Grok Bot can draw. */
export const SHAPES = [
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'tablet', 'capsule', 'cylinder', 'hex', 'gem', 'crystal', 'wedge', 'shield', 'dome',
  'arch', 'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'house', 'star',
] as const;
/** The shapes Grok Bot's own picker offers for a new bot. */
export const PICKER_SHAPES = ['blob', 'cloud', 'square', 'sparkle', 'clover', 'heart', 'flower', 'teardrop', 'tablet', 'wedge', 'house', 'star', 'hex'] as const;
export const COLORS = {
  black: '#000000', brown: '#936439', red: '#FF263C', orange: '#FF6700', yellow: '#FF9800', green: '#00C972', cyan: '#00BCA6',
  blue: '#1084FE', violet: '#9159FE', magenta: '#FF309B', gray: '#777777',
} as const;

export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 500;

export class BadSetting extends Error {}

export interface VoiceSettings {
  /** A voice from VOICES, or null for Grok's default voice. */
  voice?: string | null;
  speed?: number;
  /** A language from LANGUAGES, or null for auto-detect. */
  language?: string | null;
}

export interface NewBot {
  name: string;
  description: string;
  shape: string;
  color: string;
  voice?: string | null;
}

const has = (list: readonly unknown[], v: unknown) => list.includes(v);

/** Checks voice settings from the app. Only the fields given are changed. */
export function parseVoiceSettings(raw: unknown): VoiceSettings {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new BadSetting('settings must be an object');
  const out: VoiceSettings = {};
  if ('voice' in r) {
    if (r.voice !== null && !has(VOICES, r.voice)) throw new BadSetting(`voice must be one of ${VOICES.join(', ')}, or null for the default`);
    out.voice = r.voice as string | null;
  }
  if ('speed' in r) {
    if (!has(SPEEDS, r.speed)) throw new BadSetting(`speed must be one of ${SPEEDS.join(', ')}`);
    out.speed = r.speed as number;
  }
  if ('language' in r) {
    if (r.language !== null && !has(LANGUAGES, r.language)) throw new BadSetting('language must be a supported language code, or null for auto-detect');
    out.language = r.language as string | null;
  }
  if (!Object.keys(out).length) throw new BadSetting('nothing to change: give voice, speed or language');
  return out;
}

/** Checks a new bot from the app. */
export function parseNewBot(raw: unknown): NewBot {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new BadSetting('bot must be an object');
  const text = (v: unknown, max: number, what: string, required: boolean) => {
    const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (required && !t) throw new BadSetting(`${what} is required`);
    if (t.length > max) throw new BadSetting(`${what} is longer than ${max} characters`);
    return t;
  };
  const name = text(r.name, NAME_MAX, 'name', true);
  const description = text(r.description, DESCRIPTION_MAX, 'description', false);
  if (!has(SHAPES, r.shape)) throw new BadSetting('shape must be one of Grok Bot\'s shapes');
  if (!Object.hasOwn(COLORS, r.color as string)) throw new BadSetting(`color must be one of ${Object.keys(COLORS).join(', ')}`);
  const voice = r.voice ?? null;
  if (voice !== null && !has(VOICES, voice)) throw new BadSetting('voice must be one of Grok\'s voices, or null for the default');
  return { name, description, shape: r.shape as string, color: r.color as string, voice: voice as string | null };
}

/** The Grok Bot client plus what the overlay adds: changing a bot's voice and making new bots. */
export class OverlayGrokClient extends GrokBotClient {
  /** Saves voice, speed and language on the bot in Grok Bot (the Grok Bot app shows the change too). */
  async setVoice(botId: string, s: VoiceSettings): Promise<Bot> {
    await this.rpc('SetGrokBotAgentVoice', {
      id: botId,
      ...(s.voice === undefined ? {} : { voiceId: s.voice ?? '' }),
      ...(s.speed === undefined ? {} : { voiceSpeed: s.speed }),
      ...(s.language === undefined ? {} : { voiceLanguage: s.language ?? 'auto' }),
    });
    return this.findBot(botId);
  }

  /** Makes a new bot in Grok Bot, the way the Grok Bot app does, then sets its voice if one was picked. */
  async createBot(b: NewBot): Promise<Bot> {
    const agentId = crypto.randomUUID();
    const j = await this.rpc('CreateGrokBotTemporalAgent', {
      agentId,
      name: b.name,
      description: b.description,
      title: '',
      avatarShape: b.shape,
      avatarColor: b.color,
      harness: 'GROK_BOT_AGENT_HARNESS_KIND_TEMPORAL',
      kickstartRequested: false,
      introductionSuppressed: true,
    });
    const id = typeof j?.agent?.id === 'string' ? j.agent.id : '';
    if (!id) throw new Error('Grok Bot did not return the new bot.');
    if (b.voice) await this.setVoice(id, { voice: b.voice });
    return this.findBot(id);
  }

  private async findBot(id: string): Promise<Bot> {
    const bot = (await this.listBots()).find((x) => x.id === id);
    if (!bot) throw new Error('Grok Bot saved the change, but the bot is not in your bot list.');
    return bot;
  }
}

import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';

/** One dedicated profile, never the user's active Chrome session. Requests run in order. */
export class LocalBrowser {
  enabled = false;
  private context: BrowserContext | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly dir: string;
  private readonly headless: boolean;
  constructor(dir: string, headless = false) { this.dir = dir; this.headless = headless; }
  run(input: Record<string, unknown>): Promise<{ title: string; url: string; snapshot: string }> {
    const run = this.queue.then(() => this.execute(input));
    this.queue = run.catch(() => {});
    return run;
  }
  private async execute(input: Record<string, unknown>) {
    if (!this.enabled) throw new Error('Enable the dedicated browser in Grok Call settings first.');
    const op = input.operation;
    if (!['navigate', 'inspect', 'click', 'fill'].includes(String(op))) throw new Error('Unknown browser operation.');
    if (op === 'navigate') {
      const url = new URL(String(input.url));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https URLs are supported.');
    }
    if (!this.context) this.context = await chromium.launchPersistentContext(path.join(this.dir, 'browser-profile'), { headless: this.headless, acceptDownloads: false, timeout: 15_000 });
    const page = this.context.pages()[0] ?? await this.context.newPage();
    page.setDefaultTimeout(3000);
    if (op === 'navigate') await page.goto(String(input.url), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (op === 'click' || op === 'fill') {
      if (typeof input.selector !== 'string' || !input.selector.trim()) throw new Error('A selector is required.');
      const locator = page.locator(input.selector);
      if (op === 'click') await locator.click();
      else {
        if (typeof input.text !== 'string') throw new Error('text must be a string.');
        await locator.fill(input.text);
      }
    }
    return { title: await page.title(), url: page.url(), snapshot: (await page.locator('body').ariaSnapshot()).slice(0, 30_000) };
  }
  async close() {
    this.enabled = false;
    await this.queue;
    await this.context?.close();
    this.context = null;
  }
}

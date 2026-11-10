import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface Mock {
  url: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

export type MockHandler = (req: MockRequest, res: http.ServerResponse) => void;

/** Starts a throwaway HTTP server on a random port. */
export async function mock(handler: MockHandler): Promise<Mock> {
  const requests: MockRequest[] = [];
  const server = http.createServer(async (raw, res) => {
    const chunks: Buffer[] = [];
    for await (const c of raw) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const req = { method: raw.method!, url: raw.url!, headers: raw.headers, body };
    requests.push(req);
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** A port with nothing listening on it. */
export async function deadUrl(): Promise<string> {
  const m = await mock(() => {});
  await m.close();
  return m.url;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn() is truthy (or fails after timeoutMs). */
export async function until(fn: () => unknown, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await wait(10);
  }
}

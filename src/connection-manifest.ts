/** Recover setup metadata omitted by the marketplace, from the exact published GitHub revision.
 * Only JSON metadata is read. No repository code runs and no Grok credentials are sent. */
export async function pluginVariables(plugin: any, fetcher: typeof fetch = fetch): Promise<Record<string, unknown> | null> {
  try {
    const source = new URL(plugin.gitUrl);
    const parts = source.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    const ref = plugin.gitRef, path = plugin.gitPath ?? '.';
    if (source.origin !== 'https://github.com' || source.username || source.password || source.search || source.hash || parts.length !== 2 || parts.some((s) => !/^[\w.-]+$/.test(s)) || typeof ref !== 'string' || !/^[a-f\d]{40}$/i.test(ref) || typeof path !== 'string' || !/^[\w./-]+$/.test(path) || path.split('/').includes('..')) return null;
    const relative = path.split('/').filter((s) => s && s !== '.').join('/');
    const url = `https://raw.githubusercontent.com/${parts.join('/')}/${ref}/${relative ? relative + '/' : ''}.cursor-plugin/plugin.json`;
    const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const variables = JSON.parse(Buffer.concat(chunks).toString('utf8')).variables;
    return variables && typeof variables === 'object' && !Array.isArray(variables) && variables.properties && typeof variables.properties === 'object' && !Array.isArray(variables.properties) ? variables : null;
  } catch { return null; }
}

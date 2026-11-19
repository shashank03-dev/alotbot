import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const script = fs.readFileSync('scripts/install.sh', 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alotbot-install-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/**
 * Runs install.sh's quit_app with fake pgrep, osascript and sleep. `runs` is how many pgrep checks still find the
 * app (its window or its backend) after the quit; -1 means it never quits.
 */
function quit(name: string, running: boolean, runs: number) {
  const dir = fs.mkdtempSync(path.join(tmp, 'q'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const fn = /^quit_app\(\) \{\n[\s\S]*?\n\}\n/m.exec(script)?.[0];
  assert.ok(fn, 'install.sh has quit_app');
  fs.writeFileSync(path.join(dir, 'left'), running ? String(runs) : '0');
  fs.writeFileSync(path.join(bin, 'pgrep'), `#!/bin/bash\necho "$*" >> "${dir}/pgrep.log"\nn=$(cat "${dir}/left")\n[[ $n == 0 ]] && exit 1\n[[ -f "${dir}/quit" && $n -gt 0 ]] && echo $((n-1)) > "${dir}/left"\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/bash\necho "$*" >> "${dir}/osascript.log"\ntouch "${dir}/quit"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\n', { mode: 0o755 });
  const r = spawnSync('bash', ['-c', `${fn}quit_app "$1"; echo returned`, 'x', name], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const read = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return { ...r, pgrep: read('pgrep.log'), osascript: read('osascript.log') };
}

// The installer quit only Alotbot, then deleted Grok Call.app while it ran; its backend made a new GrokCall folder.
test('the installer quits Grok Call too, and waits for it and its backend before installing', () => {
  const idle = quit('Grok Call', false, 0);
  assert.equal(idle.status, 0);
  assert.equal(idle.osascript, '', 'not running: nothing to quit');
  assert.match(idle.pgrep, /-f \/Grok Call\.app\/Contents\//, 'the app and the Node inside it');
  const quits = quit('Grok Call', true, 3);
  assert.deepEqual([quits.status, quits.stdout], [0, 'Quitting the running Grok Call...\nreturned\n']);
  assert.equal(quits.osascript, '-e quit app "Grok Call"\n');
  const stuck = quit('Grok Call', true, -1);
  assert.equal(stuck.status, 1);
  assert.match(stuck.stderr, /Grok Call is still running\. Quit it, then run this again\. Nothing was installed\./);
  assert.ok(!stuck.stdout.includes('returned'));
  // Both apps are quit before anything is replaced, and both old copies are removed after.
  const order = ['quit_app "Alotbot"', 'quit_app "Grok Call"', 'rm -rf "$dest/Alotbot.app"'].map((s) => script.indexOf(s));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert.ok(script.includes('for old in "/Applications/Grok Call.app" "$HOME/Applications/Grok Call.app"; do'));
  assert.equal(spawnSync('bash', ['-n', 'scripts/install.sh']).status, 0);
});

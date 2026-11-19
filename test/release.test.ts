import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const check = path.resolve('mac/release-tag-check.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alotbot-release-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
function repo(name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  return dir;
}
const run = (cwd: string, tag: string) => spawnSync('bash', [check, tag], { cwd, encoding: 'utf8' });

// mac/release.sh would have uploaded the renamed app to the existing v1.0.0 release, tagged on an older commit.
test('a release refuses a version already tagged on another commit, here or on origin', () => {
  const dir = repo('local');
  assert.equal(run(dir, 'v1.0.0').status, 0, 'a new version');
  git(dir, 'tag', 'v1.0.0');
  assert.equal(run(dir, 'v1.0.0').status, 0, 'tagged on this commit: the same release again');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'two');
  const r = run(dir, 'v1.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^v1\.0\.0 is already tagged on [0-9a-f]{7}, not on this commit \([0-9a-f]{7}\)\. Bump the version in package\.json first\.$/m);
  // Only on origin (not fetched here), as an annotated tag.
  const origin = repo('origin');
  git(origin, 'tag', '-a', '-m', 'old', 'v2.0.0');
  const clone = path.join(tmp, 'clone');
  git(tmp, 'clone', '-q', '--no-tags', origin, clone);
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'new');
  assert.equal(run(clone, 'v2.0.0').status, 1, 'the remote tag counts');
  assert.equal(run(clone, 'v3.0.0').status, 0);
});

test('the version is past the v1.0.0 release made before the rename', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(pkg.version, '1.1.0');
  assert.deepEqual([lock.version, lock.packages[''].version], ['1.1.0', '1.1.0']);
  assert.match(fs.readFileSync('mac/release.sh', 'utf8'), /bash "\$repo\/mac\/release-tag-check\.sh" "\$tag"/);
});

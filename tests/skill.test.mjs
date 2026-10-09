import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';

const exec = promisify(execFile);
const helper = resolve(process.env.ARTIFACT_SHARE_TEST_HELPER || 'skills/artifact-share/scripts/artifact-share.mjs');
const binary = resolve(process.env.ARTIFACT_SHARE_TEST_BINARY || ('bin/artifact-share' + (process.platform === 'win32' ? '.exe' : '')));

test('installed helper can manage artifacts against the real server', async t => {
  await access(binary);
  const dir = await mkdtemp(join(tmpdir(), 'artifact-share-skill-'));
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const server = spawn(binary, [], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), BASE_PATH: '/nested/artifacts',
      DATABASE_URL: 'file:' + join(dir, 'test.db').replaceAll('\\', '/'),
      ADMIN_USER: 'skill-test-admin', ADMIN_PASSWORD: 'skill-test-password', COOKIE_SECURE: 'false', ALLOW_SIGNUP: 'false' },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const stopped = new Promise(r => server.once('exit', r));
      server.kill(); await stopped;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const origin = 'http://127.0.0.1:' + port;
  const base = origin + '/nested/artifacts';
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await fetch(origin + '/healthz')).ok; } catch {}
    if (ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, 'test server started');
  const login = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'skill-test-admin', password: 'skill-test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await login.json();
  const issued = await fetch(base + '/api/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ name: 'skill integration test' }),
  });
  assert.equal(issued.status, 201);
  const { key } = await issued.json();
  const userCreated = await fetch(base + '/api/admin/users', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'alice-test-password', admin: false }),
  });
  assert.equal(userCreated.status, 201);
  const env = { ...process.env, ARTIFACT_SHARE_URL: base + '/', ARTIFACT_SHARE_KEY: key };
  async function cli(...args) {
    const { stdout, stderr } = await exec(process.execPath, [helper, ...args], { env });
    assert.equal(stderr, '');
    assert.ok(!stdout.includes(key), 'API key is not printed');
    return JSON.parse(stdout);
  }
  const md = join(dir, "設計 report's.md");
  const html = join(dir, 'interactive.html');
  await writeFile(md, '# Test\n\n```mermaid\ngraph LR\n A --> B\n```');
  await writeFile(html, '<h1>Updated</h1><script>console.log("ok")</script>');
  const linked = await cli('publish', md, '--title', 'Design report');
  assert.equal(linked.visibility, 'link');
  assert.equal(linked.url, base + '/s/' + linked.id);
  assert.equal(linked.kind, 'md');
  assert.equal(linked.source_path, "設計 report's.md");
  assert.ok(!('content' in linked));
  const restricted = await cli('publish', md, '--visibility', 'users', '--usernames', 'alice', '--title', 'Restricted', '--source-path', 'docs/report.md');
  const recipients = await cli('users');
  const alice = recipients.find(u => u.name === 'alice');
  assert.deepEqual(restricted.users, [alice.id]);
  const hidden = await fetch(base + '/api/share?id=' + restricted.id);
  assert.equal(hidden.status, 404);
  const updated = await cli('update', restricted.id, html);
  assert.equal(updated.url, restricted.url);
  assert.equal(updated.title, restricted.title);
  assert.equal(updated.visibility, 'users');
  assert.deepEqual(updated.users, [alice.id]);
  assert.equal(updated.source_path, 'docs/report.md');
  assert.equal(updated.kind, 'html');
  const full = await cli('get', restricted.id);
  assert.equal(full.content, '<h1>Updated</h1><script>console.log("ok")</script>');
  const ownerOnly = await cli('update', restricted.id, html, '--users', '');
  assert.equal(ownerOnly.visibility, 'users');
  assert.deepEqual(ownerOnly.users, []);
  const widened = await cli('update', restricted.id, html, '--visibility', 'link');
  assert.equal(widened.visibility, 'link');
  assert.deepEqual(widened.users, []);
  await assert.rejects(cli('publish', md, '--visibility', 'users', '--usernames', 'unknown-user'), /Username not found/);
  await assert.rejects(cli('publish', md, '--users', alice.id), /Recipient options require/);
  await assert.rejects(cli('publish', md, '--visibility', 'users', '--users', alice.id, '--usernames', 'alice'), /either --users or --usernames/);
  const list = await cli('list');
  assert.equal(list.length, 2, 'invalid requests did not publish artifacts');
  assert.ok(list.every(a => !('content' in a) && a.url.startsWith(base + '/s/')));
  assert.deepEqual(await cli('delete', linked.id), { ok: true });
  await assert.rejects(cli('get', linked.id), /HTTP 404/);
  await assert.rejects(exec(process.execPath, [helper, 'list'], {
    env: { ...env, ARTIFACT_SHARE_KEY: 'invalid-test-key' },
  }), error => error.stderr.includes('HTTP 401') && !error.stderr.includes('invalid-test-key'));
});

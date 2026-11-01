'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { startInspector, resolveConfig, ConfigError } = require('../dist');

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startUpstream(t) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end('from upstream');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}

async function inspect(t, proxy) {
  const inspector = await startInspector({ host: '127.0.0.1', ui: { enabled: false }, proxies: [{ name: 'api', port: 0, ...proxy }] });
  t.after(() => inspector.close());
  return { inspector, url: inspector.proxies[0].url };
}

const lastEntry = inspector => inspector.store.get(inspector.store.list().at(-1).id);

test('serves matching mocks and forwards everything else', async t => {
  const upstream = await startUpstream(t);
  const { inspector, url } = await inspect(t, {
    target: upstream.url,
    mocks: [
      { method: 'post', path: '/users/:id/orders', status: 201, headers: { 'X-Mock': 'yes' }, body: { id: 'ord_1' } },
      { path: '/search', query: { q: 'ada' }, body: 'only for ada' },
    ],
  });

  const created = await request(`${url}/users/42/orders`, { method: 'POST', body: '{"qty":2}' });
  assert.equal(created.status, 201);
  assert.equal(created.headers['x-mock'], 'yes');
  assert.match(created.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(created.body), { id: 'ord_1' });

  const entry = lastEntry(inspector);
  assert.equal(entry.mock, 'POST /users/:id/orders');
  assert.equal(entry.request.body.text, '{"qty":2}');
  assert.equal(entry.response.body.text, created.body);

  assert.equal((await request(`${url}/search?q=ada`)).body, 'only for ada');
  assert.equal((await request(`${url}/search?q=bob`)).body, 'from upstream');
  assert.equal((await request(`${url}/users/42/orders`)).body, 'from upstream', 'GET does not match a POST mock');
  assert.deepEqual(upstream.hits, ['GET /search?q=bob', 'GET /users/42/orders']);
  assert.equal(lastEntry(inspector).mock, undefined);
});

test('waits for the configured delay and skips disabled mocks', async t => {
  const upstream = await startUpstream(t);
  const { url } = await inspect(t, {
    target: upstream.url,
    mocks: [
      { path: '/off', body: 'disabled', enabled: false },
      { path: '/slow', status: 503, delay: 150 },
    ],
  });

  const started = Date.now();
  const slow = await request(`${url}/slow`);
  assert.equal(slow.status, 503);
  assert.ok(Date.now() - started >= 140, 'responds after the delay');

  assert.equal((await request(`${url}/off`)).body, 'from upstream');
});

test('mock-only proxies answer 404 when nothing matches', async t => {
  const { inspector, url } = await inspect(t, { mocks: [{ method: 'GET', path: '/users/*', body: [{ id: 1 }] }] });
  assert.equal(inspector.proxies[0].target, undefined);

  assert.deepEqual(JSON.parse((await request(`${url}/users/1/profile`)).body), [{ id: 1 }]);

  const missing = await request(`${url}/orders`);
  assert.equal(missing.status, 404);
  assert.match(JSON.parse(missing.body).message, /No mock matches GET \/orders/);
  assert.equal(lastEntry(inspector).mock, 'no match');
});

test('mocked responses get CORS headers and empty 204 bodies', async t => {
  const { url } = await inspect(t, { mocks: [{ method: 'DELETE', path: '/items/:id', status: 204 }] });
  const res = await request(`${url}/items/9`, { method: 'DELETE', headers: { origin: 'http://localhost:3000' } });
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
  assert.equal(res.headers['content-length'], undefined);
  assert.equal(res.headers['access-control-allow-origin'], 'http://localhost:3000');
});

test('reload swaps mocks on running proxies and reports what needs a restart', async t => {
  const upstream = await startUpstream(t);
  const config = { host: '127.0.0.1', ui: { enabled: false }, proxies: [{ name: 'api', port: 0, target: upstream.url }] };
  const inspector = await startInspector(config);
  t.after(() => inspector.close());
  const url = inspector.proxies[0].url;

  assert.equal((await request(`${url}/status`)).body, 'from upstream');

  const result = inspector.reload({
    ...config,
    proxies: [
      { name: 'api', port: 0, target: upstream.url, mocks: [{ path: '/status', status: 500, body: { error: 'boom' } }] },
      { name: 'extra', port: 39999, target: upstream.url },
    ],
  });
  assert.deepEqual(result.updated, ['api']);
  assert.match(result.needsRestart.join(), /extra/);
  assert.deepEqual(inspector.proxies[0].mocks, ['ANY /status']);

  const mocked = await request(`${url}/status`);
  assert.equal(mocked.status, 500);
  assert.deepEqual(JSON.parse(mocked.body), { error: 'boom' });
});

test('rejects invalid mocks', () => {
  const invalid = [
    { port: 3001 },
    { port: 3001, mocks: {} },
    { port: 3001, mocks: [{ path: 'users' }] },
    { port: 3001, mocks: [{ path: '/a', status: 99 }] },
    { port: 3001, mocks: [{ path: '/a', delay: -1 }] },
    { port: 3001, mocks: [{ path: '/a', headers: 'x' }] },
  ];
  for (const proxy of invalid) {
    assert.throws(() => resolveConfig({ proxies: [proxy] }), ConfigError, JSON.stringify(proxy));
  }
});

test('the CLI applies config edits without restarting', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'http-proxy-inspector-'));
  const file = join(dir, 'http-proxy-inspector.config.json');
  const writeConfig = body =>
    writeFileSync(file, JSON.stringify({ ui: { enabled: false }, proxies: [{ name: 'live', port: 0, mocks: [{ path: '/value', body }] }] }));
  writeConfig('one');

  const cli = spawn(process.execPath, [join(__dirname, '..', 'dist', 'cli.js')], { cwd: dir, env: { ...process.env, NO_COLOR: '1' } });
  t.after(() => {
    cli.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  let output = '';
  const waitFor = pattern =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI never printed ${pattern}:\n${output}`)), 5000);
      const check = () => {
        const match = output.match(pattern);
        if (!match) return;
        clearTimeout(timer);
        cli.stdout.off('data', onData);
        resolve(match);
      };
      const onData = chunk => {
        output += chunk;
        check();
      };
      cli.stdout.on('data', onData);
      check();
    });

  const [, port] = await waitFor(/http:\/\/localhost:(\d+)/);
  const url = `http://127.0.0.1:${port}/value`;
  assert.equal((await request(url)).body, 'one');

  writeConfig('two');
  await waitFor(/Config reloaded/);
  assert.equal((await request(url)).body, 'two');
});

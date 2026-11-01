'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { startInspector } = require('../dist');

function startUpstream(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise(done => {
            server.closeAllConnections();
            server.close(done);
          }),
      });
    });
  });
}

/** Starts an upstream server plus an inspector with one proxy pointing at it. */
async function setup(t, upstreamHandler, { basePath = '', proxy = {}, ...config } = {}) {
  const upstream = await startUpstream(upstreamHandler);
  const inspector = await startInspector({
    host: '127.0.0.1',
    ui: { port: 0 },
    proxies: [{ name: 'api', port: 0, target: upstream.url + basePath, ...proxy }],
    ...config,
  });
  t.after(async () => {
    await inspector.close();
    await upstream.close();
  });
  return { upstream, inspector, proxyUrl: inspector.proxies[0].url };
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForEntry(inspector, predicate = summary => summary.state !== 'pending', timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const summary = inspector.store.list().find(predicate);
    if (summary) return inspector.store.get(summary.id);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a captured request');
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

test('forwards to the target, keeping its base path, and captures both bodies', async t => {
  let seen;
  const { upstream, inspector, proxyUrl } = await setup(
    t,
    async (req, res) => {
      seen = { method: req.method, url: req.url, host: req.headers.host, body: await readBody(req) };
      res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    },
    { basePath: '/v1/' },
  );

  const res = await request(`${proxyUrl}/users?page=2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"Ada"}',
  });

  assert.equal(res.status, 201);
  assert.equal(res.headers['x-upstream'], 'yes');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.deepEqual(seen, { method: 'POST', url: '/v1/users?page=2', host: new URL(upstream.url).host, body: '{"name":"Ada"}' });

  const entry = await waitForEntry(inspector);
  assert.equal(entry.state, 'complete');
  assert.equal(entry.proxy, 'api');
  assert.equal(entry.path, '/users?page=2');
  assert.equal(entry.url, `${upstream.url}/v1/users?page=2`);
  assert.equal(entry.response.status, 201);
  assert.equal(entry.request.body.text, '{"name":"Ada"}');
  assert.equal(entry.response.body.text, '{"ok":true}');
  assert.equal(typeof entry.timings.total, 'number');
});

test('passes compressed bodies through untouched and captures them decoded', async t => {
  const payload = JSON.stringify({ message: 'hello'.repeat(50) });
  const { inspector, proxyUrl } = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(payload));
  });

  const res = await request(`${proxyUrl}/data`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(res.body).toString(), payload);

  const entry = await waitForEntry(inspector);
  assert.equal(entry.response.body.text, payload);
});

test('streams responses instead of waiting for the whole body', async t => {
  let release;
  const released = new Promise(resolve => (release = resolve));
  const { inspector, proxyUrl } = await setup(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await released;
    res.end('data: last\n\n');
  });

  const { res, chunk } = await new Promise((resolve, reject) => {
    http.get(`${proxyUrl}/events`, response => response.once('data', data => resolve({ res: response, chunk: String(data) }))).on('error', reject);
  });
  assert.match(chunk, /first/);
  assert.equal(inspector.store.list()[0].state, 'pending');

  release();
  res.resume();
  const entry = await waitForEntry(inspector);
  assert.equal(entry.state, 'complete');
  assert.match(entry.response.body.text, /first[\s\S]*last/);
});

test('records requests the client abandons mid-response as aborted', async t => {
  const { inspector, proxyUrl } = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('partial');
  });

  await new Promise((resolve, reject) => {
    const req = http.get(`${proxyUrl}/slow`, res => res.once('data', () => {
      req.destroy();
      resolve();
    }));
    req.on('error', () => {});
    req.on('close', resolve);
    setTimeout(() => reject(new Error('no data')), 2000);
  });

  const entry = await waitForEntry(inspector);
  assert.equal(entry.state, 'aborted');
  assert.equal(entry.response.body.text, 'partial');
});

test('answers 502 and records the error when the target is down', async t => {
  const closed = await startUpstream(() => {});
  await closed.close();

  const inspector = await startInspector({
    host: '127.0.0.1',
    ui: { enabled: false },
    proxies: [{ port: 0, target: closed.url }],
  });
  t.after(() => inspector.close());

  const res = await request(`${inspector.proxies[0].url}/anything`);
  assert.equal(res.status, 502);
  assert.equal(JSON.parse(res.body).error, 'Bad Gateway');

  const entry = await waitForEntry(inspector);
  assert.equal(entry.state, 'error');
  assert.match(entry.error, /refused/i);
});

test('rewrites redirects to the target so clients stay on the proxy', async t => {
  const { proxyUrl } = await setup(
    t,
    (req, res) => {
      const base = `http://${req.headers.host}`;
      res.writeHead(302, { location: `${base}/v1/next?step=2` });
      res.end();
    },
    { basePath: '/v1' },
  );

  const res = await request(`${proxyUrl}/start`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `${proxyUrl}/next?step=2`);
});

test('handles CORS for localhost origins and leaves other origins alone', async t => {
  const methods = [];
  const { proxyUrl } = await setup(t, (req, res) => {
    methods.push(req.method);
    res.writeHead(200, { 'access-control-allow-origin': 'https://prod.example.com', 'x-total': '3' });
    res.end('ok');
  });

  const preflight = await request(`${proxyUrl}/items`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(preflight.headers['access-control-allow-headers'], 'authorization');
  assert.deepEqual(methods, [], 'preflight is answered locally');

  const actual = await request(`${proxyUrl}/items`, { headers: { origin: 'http://localhost:3000' } });
  assert.equal(actual.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal(actual.headers['access-control-allow-credentials'], 'true');
  assert.match(actual.headers['access-control-expose-headers'], /x-total/);

  const foreign = await request(`${proxyUrl}/items`, { headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.headers['access-control-allow-origin'], 'https://prod.example.com');
});

test('keeps only the latest maxEntries requests', async t => {
  const { inspector, proxyUrl } = await setup(t, (req, res) => res.end(req.url), { maxEntries: 2 });
  const removed = [];
  inspector.store.on('remove', ids => removed.push(...ids));

  for (const path of ['/a', '/b', '/c']) await request(proxyUrl + path);

  const paths = inspector.store.list().map(summary => summary.path);
  assert.deepEqual(paths, ['/b', '/c']);
  assert.equal(removed.length, 1);
});

test('truncates captured bodies but forwards them whole', async t => {
  const big = 'x'.repeat(100);
  const { inspector, proxyUrl } = await setup(
    t,
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    },
    { maxBodySize: 10 },
  );

  const res = await request(proxyUrl);
  assert.equal(res.body.toString(), big);

  const entry = await waitForEntry(inspector);
  assert.equal(entry.response.body.size, 100);
  assert.equal(entry.response.body.truncated, true);
  assert.equal(entry.response.body.text, 'x'.repeat(10));
});

test('UI API lists, details, streams and clears requests', async t => {
  const { inspector, proxyUrl } = await setup(t, (req, res) => res.end('pong'));
  const ui = inspector.uiUrl;

  const page = await request(`${ui}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);

  const forbidden = await request(`${ui}/api/requests`, { headers: { host: 'evil.example' } });
  assert.equal(forbidden.status, 403);

  const events = await new Promise((resolve, reject) => {
    http.get(`${ui}/api/events`, resolve).on('error', reject);
  });
  events.setEncoding('utf8');
  let stream = '';
  const sawRequest = new Promise(resolve => {
    events.on('data', chunk => {
      stream += chunk;
      if (stream.includes('event: request')) resolve();
    });
  });

  await request(`${proxyUrl}/ping`);
  await sawRequest;
  events.destroy();

  const list = JSON.parse((await request(`${ui}/api/requests`)).body);
  assert.equal(typeof list.instance, 'string');
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].path, '/ping');

  const detail = JSON.parse((await request(`${ui}/api/requests/${list.requests[0].id}`)).body);
  assert.equal(detail.response.body.text, 'pong');

  const cleared = await request(`${ui}/api/requests`, { method: 'DELETE' });
  assert.equal(cleared.status, 204);
  assert.equal(inspector.store.list().length, 0);
});

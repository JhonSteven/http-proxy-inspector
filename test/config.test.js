'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { resolveConfig, parseProxyFlag, ConfigError } = require('../dist');
const { parseArgs, buildConfig } = require('../dist/cli');

test('resolveConfig fills defaults', () => {
  const config = resolveConfig({ proxies: [{ port: 3001, target: 'https://api.example.com/v1' }] });
  assert.equal(config.host, 'localhost');
  assert.deepEqual(config.ui, { enabled: true, port: 4000 });
  assert.equal(config.proxies[0].name, 'api.example.com');
  assert.equal(config.proxies[0].target.href, 'https://api.example.com/v1');
  assert.equal(config.proxies[0].changeOrigin, true);
  assert.equal(config.proxies[0].cors, true);
});

test('resolveConfig rejects invalid configs', () => {
  const invalid = [
    {},
    { proxies: [] },
    { proxies: [{ port: 3001, target: 'not a url' }] },
    { proxies: [{ port: 3001, target: 'ftp://example.com' }] },
    { proxies: [{ port: 3001, target: 'https://example.com/?key=1' }] },
    { proxies: [{ port: 70000, target: 'https://example.com' }] },
    { proxies: [{ port: 3001, target: 'https://a.com' }, { port: 3001, target: 'https://b.com' }] },
    { ui: { port: 3001 }, proxies: [{ port: 3001, target: 'https://a.com' }] },
  ];
  for (const config of invalid) {
    assert.throws(() => resolveConfig(config), ConfigError, JSON.stringify(config));
  }
});

test('resolveConfig keeps proxy names unique', () => {
  const config = resolveConfig({
    proxies: [
      { port: 3001, target: 'https://api.example.com' },
      { port: 3002, target: 'https://api.example.com' },
    ],
  });
  assert.deepEqual(
    config.proxies.map(proxy => proxy.name),
    ['api.example.com', 'api.example.com:3002'],
  );
});

test('parseProxyFlag accepts an optional name', () => {
  assert.deepEqual(parseProxyFlag('3001=https://api.example.com'), { port: 3001, target: 'https://api.example.com' });
  assert.deepEqual(parseProxyFlag('users:3001=https://api.example.com/v1'), {
    name: 'users',
    port: 3001,
    target: 'https://api.example.com/v1',
  });
  assert.throws(() => parseProxyFlag('3001'), ConfigError);
});

test('parseArgs reads flags and the command after --', () => {
  const options = parseArgs(['-p', '3001=https://a.com', '--proxy=b:3002=https://b.com', '--ui-port', '5000', '-q', '--', 'next', 'dev']);
  assert.deepEqual(options.proxies, [
    { port: 3001, target: 'https://a.com' },
    { name: 'b', port: 3002, target: 'https://b.com' },
  ]);
  assert.equal(options.uiPort, 5000);
  assert.equal(options.quiet, true);
  assert.deepEqual(options.run, ['next', 'dev']);
  assert.throws(() => parseArgs(['--nope']), ConfigError);
  assert.throws(() => parseArgs(['--ui-port']), ConfigError);
});

test('buildConfig merges the config file with --proxy flags', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'http-proxy-inspector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'http-proxy-inspector.config.json'),
    JSON.stringify({
      ui: { port: 4100 },
      proxies: [
        { name: 'users', port: 3001, target: 'https://users.example.com' },
        { name: 'old', port: 3002, target: 'https://old.example.com' },
      ],
    }),
  );

  const config = await buildConfig(parseArgs(['-p', 'new:3002=https://new.example.com', '--no-ui']), dir);
  assert.deepEqual(
    config.proxies.map(proxy => proxy.name),
    ['users', 'new'],
  );
  assert.deepEqual(config.ui, { port: 4100, enabled: false });
});

test('buildConfig loads ESM config files', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'http-proxy-inspector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'http-proxy-inspector.config.mjs'),
    "export default { proxies: [{ name: 'esm', port: 3005, target: process.env.HTTP_INSPECTOR_TEST_TARGET ?? 'https://esm.example.com' }] };\n",
  );

  const config = await buildConfig(parseArgs([]), dir);
  assert.equal(config.proxies[0].name, 'esm');
});

test('buildConfig explains how to start when nothing is configured', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'http-proxy-inspector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(buildConfig(parseArgs([]), dir), /init/);
});

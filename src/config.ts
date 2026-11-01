import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InspectorConfig, MockConfig, ProxyConfig, ResolvedConfig, ResolvedMock, ResolvedProxyConfig } from './types';

export const CONFIG_FILES = [
  'http-proxy-inspector.config.json',
  'http-proxy-inspector.config.js',
  'http-proxy-inspector.config.mjs',
  'http-proxy-inspector.config.cjs',
];

export const DEFAULTS = {
  host: 'localhost',
  uiPort: 4000,
  maxEntries: 500,
  maxBodySize: 1024 * 1024,
};

/** Identity helper that gives editor autocompletion in JS config files. */
export function defineConfig(config: InspectorConfig): InspectorConfig {
  return config;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  return CONFIG_FILES.map(file => resolve(cwd, file)).find(file => existsSync(file));
}

export async function loadConfigFile(file: string): Promise<Partial<InspectorConfig>> {
  const fullPath = resolve(file);
  if (!existsSync(fullPath)) {
    throw new ConfigError(`Config file not found: ${fullPath}`);
  }

  if (extname(fullPath) === '.json') {
    try {
      return JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (error) {
      throw new ConfigError(`Invalid JSON in ${fullPath}: ${(error as Error).message}`);
    }
  }

  // Bypass the module caches so edits are picked up when the file is reloaded.
  delete require.cache[fullPath];
  const mod = await import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`);
  const config = mod.default ?? mod;
  return typeof config === 'function' ? await config() : config;
}

/** Parses a `--proxy` flag value: `3001=https://api.example.com` or `name:3001=https://api.example.com`. */
export function parseProxyFlag(value: string): ProxyConfig {
  const separator = value.indexOf('=');
  if (separator === -1) {
    throw new ConfigError(`Invalid --proxy "${value}". Expected <port>=<target>, e.g. 3001=https://api.example.com`);
  }

  const left = value.slice(0, separator);
  const target = value.slice(separator + 1);
  const colon = left.lastIndexOf(':');
  const name = colon === -1 ? undefined : left.slice(0, colon);
  const port = Number(colon === -1 ? left : left.slice(colon + 1));

  return name ? { name, port, target } : { port, target };
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns `/users/:id/*` into a regular expression. A trailing slash is optional. */
function compilePath(path: string): RegExp {
  const source = path
    .replace(/\/+$/, '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/:\w+/g, '[^/]+');
  return new RegExp(`^${source}/?$`);
}

function resolveMock(mock: MockConfig, label: string): ResolvedMock | undefined {
  if (!isPlainObject(mock)) throw new ConfigError(`${label} must be an object with at least a "path".`);
  if (typeof mock.path !== 'string' || !mock.path.startsWith('/')) {
    throw new ConfigError(`${label}.path must start with "/" (got ${JSON.stringify(mock.path)}).`);
  }
  if (mock.method !== undefined && (typeof mock.method !== 'string' || !mock.method.trim())) {
    throw new ConfigError(`${label}.method must be an HTTP method such as "GET".`);
  }
  const status = mock.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new ConfigError(`${label}.status must be an integer between 200 and 599 (got ${JSON.stringify(mock.status)}).`);
  }
  const delay = mock.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new ConfigError(`${label}.delay must be a non-negative number of milliseconds.`);
  }
  for (const [field, value] of [['headers', mock.headers], ['query', mock.query]] as const) {
    if (value !== undefined && !isPlainObject(value)) throw new ConfigError(`${label}.${field} must be an object.`);
  }
  if (mock.enabled === false) return undefined;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(mock.headers ?? {})) headers[name.toLowerCase()] = String(value);

  let body: Buffer;
  let contentType: string;
  if (mock.body === undefined || mock.body === null) {
    body = Buffer.alloc(0);
    contentType = 'text/plain; charset=utf-8';
  } else if (typeof mock.body === 'string') {
    body = Buffer.from(mock.body);
    contentType = 'text/plain; charset=utf-8';
  } else if (Buffer.isBuffer(mock.body)) {
    body = mock.body;
    contentType = 'application/octet-stream';
  } else {
    try {
      body = Buffer.from(JSON.stringify(mock.body, null, 2));
    } catch (error) {
      throw new ConfigError(`${label}.body cannot be converted to JSON: ${(error as Error).message}`);
    }
    contentType = 'application/json; charset=utf-8';
  }
  if (body.length > 0 && !headers['content-type']) headers['content-type'] = contentType;

  const method = mock.method?.trim().toUpperCase();
  const anyMethod = method === undefined || method === '*' || method === 'ANY';
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(mock.query ?? {})) query[name] = String(value);

  return {
    label: `${anyMethod ? 'ANY' : method} ${mock.path}`,
    method: anyMethod ? undefined : method,
    pattern: compilePath(mock.path),
    query: Object.keys(query).length > 0 ? query : undefined,
    status,
    headers,
    body,
    delay,
  };
}

function resolveProxy(proxy: ProxyConfig, index: number): ResolvedProxyConfig {
  const label = `proxies[${index}]`;
  if (!proxy || typeof proxy !== 'object') {
    throw new ConfigError(`${label} must be an object with "port" and "target".`);
  }
  if (!isPort(proxy.port)) {
    throw new ConfigError(`${label}.port must be an integer between 0 and 65535 (got ${JSON.stringify(proxy.port)}).`);
  }
  if (proxy.mocks !== undefined && !Array.isArray(proxy.mocks)) {
    throw new ConfigError(`${label}.mocks must be a list.`);
  }
  if (proxy.target === undefined && !proxy.mocks?.length) {
    throw new ConfigError(`${label} needs a "target" URL, "mocks", or both.`);
  }

  const mocks = (proxy.mocks ?? [])
    .map((mock, mockIndex) => resolveMock(mock, `${label}.mocks[${mockIndex}]`))
    .filter((mock): mock is ResolvedMock => mock !== undefined);

  let target: URL | undefined;
  if (proxy.target !== undefined) {
    try {
      target = new URL(proxy.target);
    } catch {
      throw new ConfigError(`${label}.target must be an absolute URL (got ${JSON.stringify(proxy.target)}).`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new ConfigError(`${label}.target must use http or https (got ${target.protocol}).`);
    }
    if (target.search || target.hash) {
      throw new ConfigError(`${label}.target must not include a query string or hash.`);
    }
  }

  const cors = proxy.cors ?? true;
  if (typeof cors !== 'boolean' && !(Array.isArray(cors) && cors.every(origin => typeof origin === 'string'))) {
    throw new ConfigError(`${label}.cors must be true, false or a list of origins.`);
  }
  if (proxy.timeout !== undefined && !(Number.isFinite(proxy.timeout) && proxy.timeout > 0)) {
    throw new ConfigError(`${label}.timeout must be a positive number of milliseconds.`);
  }

  return {
    name: proxy.name?.trim() || target?.host || `mocks:${proxy.port}`,
    port: proxy.port,
    target,
    mocks,
    changeOrigin: proxy.changeOrigin ?? true,
    secure: proxy.secure ?? true,
    cors,
    timeout: proxy.timeout,
  };
}

export function resolveConfig(config: Partial<InspectorConfig>): ResolvedConfig {
  if (!config || typeof config !== 'object') {
    throw new ConfigError('Config must be an object.');
  }
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) {
    throw new ConfigError('Config needs at least one proxy, e.g. { "proxies": [{ "port": 3001, "target": "https://api.example.com" }] }');
  }

  const ui = {
    enabled: config.ui?.enabled ?? true,
    port: config.ui?.port ?? DEFAULTS.uiPort,
  };
  if (!isPort(ui.port)) {
    throw new ConfigError(`ui.port must be an integer between 0 and 65535 (got ${JSON.stringify(ui.port)}).`);
  }

  const proxies = config.proxies.map(resolveProxy);

  const usedPorts = new Map<number, string>();
  if (ui.enabled && ui.port !== 0) usedPorts.set(ui.port, 'the UI');
  for (const proxy of proxies) {
    if (proxy.port === 0) continue;
    const owner = usedPorts.get(proxy.port);
    if (owner) {
      throw new ConfigError(`Port ${proxy.port} is used by both "${proxy.name}" and ${owner}.`);
    }
    usedPorts.set(proxy.port, `"${proxy.name}"`);
  }

  // Keep names unique so the UI filter can tell proxies apart.
  const seen = new Set<string>();
  for (const proxy of proxies) {
    if (seen.has(proxy.name)) proxy.name = `${proxy.name}:${proxy.port}`;
    seen.add(proxy.name);
  }

  const maxEntries = config.maxEntries ?? DEFAULTS.maxEntries;
  const maxBodySize = config.maxBodySize ?? DEFAULTS.maxBodySize;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new ConfigError('maxEntries must be a positive integer.');
  }
  if (!Number.isInteger(maxBodySize) || maxBodySize < 0) {
    throw new ConfigError('maxBodySize must be a non-negative integer (bytes).');
  }

  return {
    host: config.host || DEFAULTS.host,
    ui,
    proxies,
    maxEntries,
    maxBodySize,
  };
}

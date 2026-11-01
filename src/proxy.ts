import { randomUUID } from 'node:crypto';
import {
  Agent as HttpAgent,
  STATUS_CODES,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type RequestListener,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { BodyCollector } from './body';
import type { RequestStore } from './store';
import type { CorsOption, Headers, RequestState, ResolvedMock, ResolvedProxyConfig } from './types';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const TLS_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) || hostname.endsWith('.localhost');
}

/** Maps a request to the proxy onto the target, keeping the target's base path. */
export function buildUpstreamUrl(target: URL, requestUrl: string): URL {
  let pathAndQuery = requestUrl || '/';
  if (/^https?:\/\//i.test(pathAndQuery)) {
    const absolute = new URL(pathAndQuery);
    pathAndQuery = absolute.pathname + absolute.search;
  }
  if (!pathAndQuery.startsWith('/')) pathAndQuery = `/${pathAndQuery}`;

  const basePath = target.pathname.replace(/\/+$/, '');
  return new URL(target.origin + basePath + pathAndQuery);
}

/** Points redirects to the target back at the proxy so the client keeps going through it. */
export function rewriteLocation(location: string, target: URL, proxyOrigin: string): string {
  let url: URL;
  try {
    url = new URL(location, target);
  } catch {
    return location;
  }
  if (url.origin !== target.origin) return location;

  const basePath = target.pathname.replace(/\/+$/, '');
  if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return location;

  return proxyOrigin + (url.pathname.slice(basePath.length) || '/') + url.search + url.hash;
}

function allowedOrigin(cors: CorsOption, origin: string | undefined): string | undefined {
  if (!origin || cors === false) return undefined;
  if (cors === true) {
    try {
      return isLoopbackHost(new URL(origin).hostname) ? origin : undefined;
    } catch {
      return undefined;
    }
  }
  return cors.includes('*') || cors.includes(origin) ? origin : undefined;
}

function cloneHeaders(headers: IncomingHttpHeaders): Headers {
  const copy: Headers = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) copy[name] = value;
  }
  return copy;
}

function forwardableHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = String(headers.connection ?? '')
    .split(',')
    .map(token => token.trim().toLowerCase());
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.includes(name)) continue;
    result[name] = value;
  }
  return result;
}

function corsHeaders(origin: string): OutgoingHttpHeaders {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
}

function applyCors(headers: OutgoingHttpHeaders, origin: string, upstreamHeaders: IncomingHttpHeaders): void {
  for (const name of Object.keys(headers)) {
    if (name.startsWith('access-control-')) delete headers[name];
  }
  const vary = headers.vary ? String(headers.vary) : '';
  Object.assign(headers, corsHeaders(origin));
  if (vary) headers.vary = /(^|,)\s*(origin|\*)\s*(,|$)/i.test(vary) ? vary : `${vary}, Origin`;

  const exposed = Object.keys(upstreamHeaders).filter(name => !HOP_BY_HOP.has(name));
  if (exposed.length > 0) headers['access-control-expose-headers'] = exposed.join(', ');
}

function describeError(error: NodeJS.ErrnoException, url: URL): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return `Connection refused by ${url.host}.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not resolve ${url.hostname}.`;
    case 'ECONNRESET':
      return `Connection to ${url.host} was reset.`;
  }
  if (error.code && TLS_ERRORS.has(error.code)) {
    return `${error.message}. Set "secure": false on this proxy to accept self-signed certificates.`;
  }
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

/** Returns the first mock that matches the request, if any. */
export function findMock(mocks: ResolvedMock[], method: string, requestUrl: string): ResolvedMock | undefined {
  let url: URL;
  try {
    url = new URL(requestUrl.startsWith('/') ? `http://localhost${requestUrl}` : requestUrl);
  } catch {
    return undefined;
  }
  return mocks.find(
    mock =>
      (!mock.method || mock.method === method) &&
      mock.pattern.test(url.pathname) &&
      Object.entries(mock.query ?? {}).every(([name, value]) => url.searchParams.get(name) === value),
  );
}

function toHeaders(headers: OutgoingHttpHeaders): Headers {
  const result: Headers = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = Array.isArray(value) ? value : String(value);
  }
  return result;
}

export function createProxyHandler(proxy: ResolvedProxyConfig, store: RequestStore, maxBodySize: number): RequestListener {
  // Settings are read from `proxy` on every request, so a config reload applies right away.
  const agents = new Map<string, HttpAgent>();
  const agentFor = (target: URL): HttpAgent => {
    const key = `${target.protocol}|${proxy.secure}`;
    let agent = agents.get(key);
    if (!agent) {
      agent =
        target.protocol === 'https:'
          ? new HttpsAgent({ keepAlive: true, rejectUnauthorized: proxy.secure })
          : new HttpAgent({ keepAlive: true });
      agents.set(key, agent);
    }
    return agent;
  };

  return (req, res) => {
    const start = performance.now();
    const elapsed = () => Math.round((performance.now() - start) * 100) / 100;
    const method = req.method ?? 'GET';
    const origin = allowedOrigin(proxy.cors, req.headers.origin);

    // Answer CORS preflights locally: the real API would reject a localhost origin.
    if (origin && method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, {
        ...corsHeaders(origin),
        'access-control-allow-methods': req.headers['access-control-request-method'],
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }

    const target = proxy.target;
    const mock = findMock(proxy.mocks, method, req.url ?? '/');

    let url: URL;
    try {
      url = target
        ? buildUpstreamUrl(target, req.url ?? '/')
        : new URL(`http://${req.headers.host ?? `localhost:${proxy.port}`}${req.url ?? '/'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Invalid request URL');
      return;
    }

    const entry = store.add({
      id: randomUUID(),
      proxy: proxy.name,
      proxyPort: req.socket.localPort ?? proxy.port,
      method,
      path: req.url ?? '/',
      url: url.href,
      startedAt: new Date().toISOString(),
      state: 'pending',
      mock: mock ? mock.label : target ? undefined : 'no match',
      request: { headers: cloneHeaders(req.headers) },
      timings: {},
    });

    const requestBody = new BodyCollector(maxBodySize);
    const responseBody = new BodyCollector(maxBodySize);
    let finished = false;
    let cancel = () => {};

    const finish = (state: RequestState, error?: string) => {
      if (finished) return;
      finished = true;
      entry.state = state;
      entry.error = error;
      entry.timings.total = elapsed();
      entry.request.body = requestBody.finish(entry.request.headers);
      if (entry.response) entry.response.body = responseBody.finish(entry.response.headers);
      store.update(entry);
    };

    res.on('close', () => {
      if (res.writableFinished) return;
      finish('aborted', 'The client closed the connection before the response finished.');
      cancel();
    });

    // Errors on the client side are reported through the `close` handler above.
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('data', (chunk: Buffer) => requestBody.push(chunk));

    if (mock || !target) {
      const respond = () => {
        if (finished || res.destroyed) return;
        const status = mock ? mock.status : 404;
        const body = mock
          ? mock.body
          : Buffer.from(
              JSON.stringify({
                error: 'Not Found',
                message: `No mock matches ${method} ${url.pathname} and this proxy has no target.`,
                proxy: proxy.name,
              }),
            );
        const headers: OutgoingHttpHeaders = mock ? { ...mock.headers } : { 'content-type': 'application/json; charset=utf-8' };
        const sendsBody = status !== 204 && status !== 304 && method !== 'HEAD';
        if (status !== 204 && status !== 304) headers['content-length'] = String(body.length);
        if (origin) applyCors(headers, origin, { ...headers } as IncomingHttpHeaders);

        entry.timings.ttfb = elapsed();
        entry.response = { status, statusText: STATUS_CODES[status] ?? '', headers: toHeaders(headers) };
        if (sendsBody) responseBody.push(body);
        res.writeHead(status, headers);
        res.end(sendsBody ? body : undefined);
        finish('complete');
      };

      // Read the whole request first so its body is captured, then answer after the configured delay.
      req.on('end', () => {
        if (!mock?.delay) return respond();
        const timer = setTimeout(respond, mock.delay);
        cancel = () => clearTimeout(timer);
      });
      return;
    }

    const headers = forwardableHeaders(req.headers);
    if (proxy.changeOrigin) headers.host = url.host;

    const isHttps = url.protocol === 'https:';
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const upstream = (isHttps ? httpsRequest : httpRequest)(url, {
      method,
      headers,
      agent: agentFor(target),
      // SNI must name the target even when the Host header is kept (changeOrigin: false).
      ...(isHttps && isIP(hostname) === 0 ? { servername: hostname } : {}),
    });
    cancel = () => upstream.destroy();

    const timeout = proxy.timeout;
    if (timeout) {
      upstream.setTimeout(timeout, () => {
        upstream.destroy(new Error(`No response from ${url.host} within ${timeout} ms.`));
      });
    }

    upstream.on('response', upstreamRes => {
      const status = upstreamRes.statusCode ?? 502;
      entry.timings.ttfb = elapsed();
      entry.response = {
        status,
        statusText: upstreamRes.statusMessage ?? '',
        headers: cloneHeaders(upstreamRes.headers),
      };
      store.update(entry);

      const responseHeaders = forwardableHeaders(upstreamRes.headers);
      const proxyOrigin = `http://${req.headers.host ?? `localhost:${entry.proxyPort}`}`;
      if (typeof responseHeaders.location === 'string') {
        responseHeaders.location = rewriteLocation(responseHeaders.location, target, proxyOrigin);
      }
      if (proxy.changeOrigin && Array.isArray(responseHeaders['set-cookie'])) {
        // Cookies scoped to the target domain would be rejected on localhost.
        responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(cookie => cookie.replace(/;\s*domain=[^;]*/gi, ''));
      }
      if (origin) applyCors(responseHeaders, origin, upstreamRes.headers);

      res.writeHead(status, upstreamRes.statusMessage, responseHeaders);
      upstreamRes.on('data', (chunk: Buffer) => responseBody.push(chunk));
      upstreamRes.on('end', () => finish('complete'));
      upstreamRes.on('error', error => {
        finish('error', describeError(error, url));
        res.destroy();
      });
      upstreamRes.pipe(res);
    });

    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (finished) return;
      const message = describeError(error, url);
      finish('error', message);
      req.unpipe(upstream);
      req.resume();

      if (res.headersSent) {
        res.destroy();
      } else if (!res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', ...(origin ? corsHeaders(origin) : {}) });
        res.end(JSON.stringify({ error: 'Bad Gateway', message, proxy: proxy.name, target: url.href }));
      }
    });

    req.pipe(upstream);
  };
}

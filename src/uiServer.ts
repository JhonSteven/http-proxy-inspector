import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestListener, ServerResponse } from 'node:http';
import { isLoopbackHost } from './proxy';
import { summarize, type RequestStore } from './store';
import type { CapturedRequest } from './types';
import { VERSION } from './version';

const UI_DIR = join(__dirname, '..', 'ui');

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/theme.js': { file: 'theme.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HEARTBEAT_MS = 15_000;

export interface UiProxyInfo {
  name: string;
  port: number;
  target: string;
  url: string;
}

export interface UiOptions {
  proxies: UiProxyInfo[];
  maxEntries: number;
  maxBodySize: number;
  /** Reject requests whose Host header is not a loopback name (DNS rebinding protection). */
  checkHost: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function requestHostname(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return undefined;
  }
}

export function createUiHandler(store: RequestStore, options: UiOptions): RequestListener {
  // Lets open pages notice that the inspector restarted and drop stale requests.
  const instance = randomUUID();

  return async (req, res) => {
    if (options.checkHost) {
      const hostname = requestHostname(req.headers.host);
      if (!hostname || !isLoopbackHost(hostname)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden host');
        return;
      }
    }

    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET' && STATIC_FILES[pathname]) {
      const { file, type } = STATIC_FILES[pathname];
      try {
        const content = await readFile(join(UI_DIR, file));
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-cache',
          'content-security-policy': CONTENT_SECURITY_POLICY,
          'x-content-type-options': 'nosniff',
        });
        res.end(content);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`UI file missing: ${file}`);
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/info') {
      sendJson(res, 200, {
        version: VERSION,
        proxies: options.proxies,
        maxEntries: options.maxEntries,
        maxBodySize: options.maxBodySize,
      });
      return;
    }

    if (pathname === '/api/requests') {
      if (method === 'GET') {
        sendJson(res, 200, { instance, seq: store.currentSeq, requests: store.list() });
      } else if (method === 'DELETE') {
        store.clear();
        res.writeHead(204);
        res.end();
      } else {
        sendJson(res, 405, { error: 'Method not allowed' });
      }
      return;
    }

    const detail = pathname.match(/^\/api\/requests\/([\w-]+)$/);
    if (method === 'GET' && detail) {
      const entry = store.get(detail[1]);
      if (entry) sendJson(res, 200, entry);
      else sendJson(res, 404, { error: 'Request not found (it may have been evicted or cleared).' });
      return;
    }

    if (method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');

      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const onUpdate = (entry: CapturedRequest) => send('request', summarize(entry));
      const onRemove = (ids: string[]) => send('remove', ids);
      const onClear = () => send('clear', {});
      const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

      store.on('update', onUpdate);
      store.on('remove', onRemove);
      store.on('clear', onClear);
      req.on('close', () => {
        clearInterval(heartbeat);
        store.off('update', onUpdate);
        store.off('remove', onRemove);
        store.off('clear', onClear);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  };
}

import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveConfig } from './config';
import { createProxyHandler, isLoopbackHost } from './proxy';
import { RequestStore } from './store';
import type { InspectorConfig, ResolvedConfig } from './types';
import { createUiHandler, type UiProxyInfo } from './uiServer';

export interface Inspector {
  config: ResolvedConfig;
  store: RequestStore;
  proxies: UiProxyInfo[];
  uiUrl?: string;
  close(): Promise<void>;
}

function closeServers(servers: Server[]): Promise<void> {
  return Promise.all(
    servers.map(
      server =>
        new Promise<void>(resolve => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          // Drop keep-alive and SSE connections so close() does not wait for them.
          server.closeAllConnections();
        }),
    ),
  ).then(() => undefined);
}

/**
 * Listens on `port`. "localhost" binds both 127.0.0.1 and ::1, because clients
 * may resolve localhost to either one.
 */
async function listen(handler: RequestListener, port: number, host: string): Promise<Server[]> {
  const addresses = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const servers: Server[] = [];
  let actualPort = port;

  for (const address of addresses) {
    const server = createServer(handler);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(actualPort, address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // IPv6 may be disabled on this machine; 127.0.0.1 is enough then.
      if (address === '::1' && servers.length > 0 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
      await closeServers(servers);
      if (code === 'EADDRINUSE') throw new Error(`Port ${actualPort} is already in use (${address}).`);
      throw error;
    }
    servers.push(server);
    actualPort = (server.address() as AddressInfo).port;
  }

  return servers;
}

function displayHost(host: string): string {
  if (host === 'localhost' || host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') ? `[${host}]` : host;
}

function displayTarget(target: URL): string {
  return target.origin + target.pathname.replace(/\/+$/, '');
}

/** Starts every configured proxy plus the UI. Call `close()` to stop them. */
export async function startInspector(config: InspectorConfig): Promise<Inspector> {
  const resolved = resolveConfig(config);
  const store = new RequestStore(resolved.maxEntries);
  const host = displayHost(resolved.host);
  const servers: Server[] = [];

  try {
    const proxies: UiProxyInfo[] = [];
    for (const proxy of resolved.proxies) {
      const listening = await listen(createProxyHandler(proxy, store, resolved.maxBodySize), proxy.port, resolved.host);
      servers.push(...listening);
      const port = (listening[0].address() as AddressInfo).port;
      proxies.push({ name: proxy.name, port, target: displayTarget(proxy.target), url: `http://${host}:${port}` });
    }

    let uiUrl: string | undefined;
    if (resolved.ui.enabled) {
      const handler = createUiHandler(store, {
        proxies,
        maxEntries: resolved.maxEntries,
        maxBodySize: resolved.maxBodySize,
        checkHost: isLoopbackHost(resolved.host),
      });
      const listening = await listen(handler, resolved.ui.port, resolved.host);
      servers.push(...listening);
      uiUrl = `http://${host}:${(listening[0].address() as AddressInfo).port}`;
    }

    return { config: resolved, store, proxies, uiUrl, close: () => closeServers(servers) };
  } catch (error) {
    await closeServers(servers);
    throw error;
  }
}

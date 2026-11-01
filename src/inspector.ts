import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveConfig } from './config';
import { createProxyHandler, isLoopbackHost } from './proxy';
import { RequestStore } from './store';
import type { InspectorConfig, ResolvedConfig, ResolvedProxyConfig } from './types';
import { createUiHandler, type UiProxyInfo } from './uiServer';

export interface ReloadResult {
  /** Proxies whose settings (target, mocks, CORS, ...) were updated in place. */
  updated: string[];
  /** Changes that only take effect after a restart, such as new or removed ports. */
  needsRestart: string[];
}

export interface Inspector {
  config: ResolvedConfig;
  store: RequestStore;
  proxies: UiProxyInfo[];
  uiUrl?: string;
  /** Applies a new config to the running proxies without restarting them. */
  reload(config: InspectorConfig): ReloadResult;
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

function proxyInfo(proxy: ResolvedProxyConfig, port: number, host: string): UiProxyInfo {
  return {
    name: proxy.name,
    port,
    target: proxy.target ? displayTarget(proxy.target) : undefined,
    url: `http://${host}:${port}`,
    mocks: proxy.mocks.map(mock => mock.label),
  };
}

/** Port 0 means "any free port", so those proxies are matched by name instead. */
function proxyKey(proxy: ResolvedProxyConfig): string {
  return proxy.port === 0 ? `name:${proxy.name}` : `port:${proxy.port}`;
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
      proxies.push(proxyInfo(proxy, (listening[0].address() as AddressInfo).port, host));
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

    const reload = (nextConfig: InspectorConfig): ReloadResult => {
      const next = resolveConfig(nextConfig);
      const result: ReloadResult = { updated: [], needsRestart: [] };
      const running = new Map(resolved.proxies.map((proxy, index) => [proxyKey(proxy), index]));

      for (const proxy of next.proxies) {
        const index = running.get(proxyKey(proxy));
        if (index === undefined) {
          result.needsRestart.push(`new proxy "${proxy.name}" on port ${proxy.port}`);
          continue;
        }
        running.delete(proxyKey(proxy));
        // Handlers read their settings from this object on every request.
        Object.assign(resolved.proxies[index], proxy);
        Object.assign(proxies[index], proxyInfo(proxy, proxies[index].port, host));
        result.updated.push(proxy.name);
      }
      for (const index of running.values()) {
        result.needsRestart.push(`removed proxy "${resolved.proxies[index].name}" on port ${resolved.proxies[index].port}`);
      }
      if (next.host !== resolved.host || next.ui.port !== resolved.ui.port || next.ui.enabled !== resolved.ui.enabled) {
        result.needsRestart.push('host or UI settings');
      }
      if (next.maxEntries !== resolved.maxEntries || next.maxBodySize !== resolved.maxBodySize) {
        result.needsRestart.push('maxEntries or maxBodySize');
      }

      store.emit('config');
      return result;
    };

    return { config: resolved, store, proxies, uiUrl, reload, close: () => closeServers(servers) };
  } catch (error) {
    await closeServers(servers);
    throw error;
  }
}

/**
 * CORS handling for browser clients calling a proxy.
 * - `true`: answer preflights and allow any localhost origin (default).
 * - `string[]`: allow only these origins (`"*"` allows any origin).
 * - `false`: do not touch CORS; preflights and headers pass through to the target.
 */
export type CorsOption = boolean | string[];

export interface ProxyConfig {
  /** Label shown in the UI. Defaults to the target host. */
  name?: string;
  /** Local port the proxy listens on, e.g. 3001. */
  port: number;
  /** Real URL requests are forwarded to. May include a base path, e.g. https://api.example.com/v1 */
  target: string;
  /** Rewrite the Host header to the target host. Default: true. */
  changeOrigin?: boolean;
  /** Verify the target's TLS certificate. Set to false for self-signed targets. Default: true. */
  secure?: boolean;
  /** See {@link CorsOption}. Default: true. */
  cors?: CorsOption;
  /** Abort the upstream request after this many milliseconds without activity. Default: no timeout. */
  timeout?: number;
}

export interface UiConfig {
  /** Serve the web UI. Default: true. */
  enabled?: boolean;
  /** Port for the web UI. Default: 4000. */
  port?: number;
}

export interface InspectorConfig {
  /** Interface to bind proxies and UI to. Default: "localhost" (127.0.0.1 and ::1). */
  host?: string;
  ui?: UiConfig;
  proxies: ProxyConfig[];
  /** Maximum number of requests kept in memory. Default: 500. */
  maxEntries?: number;
  /** Maximum bytes captured per request/response body. Default: 1 MB. */
  maxBodySize?: number;
}

export interface ResolvedProxyConfig {
  name: string;
  port: number;
  target: URL;
  changeOrigin: boolean;
  secure: boolean;
  cors: CorsOption;
  timeout?: number;
}

export interface ResolvedConfig {
  host: string;
  ui: { enabled: boolean; port: number };
  proxies: ResolvedProxyConfig[];
  maxEntries: number;
  maxBodySize: number;
}

export type Headers = Record<string, string | string[]>;

export interface CapturedBody {
  /** Bytes as received on the wire (may be compressed). */
  size: number;
  /** True when only the first `maxBodySize` bytes were captured. */
  truncated: boolean;
  contentType?: string;
  /** Decoded body when it is textual. */
  text?: string;
  /** Explains why there is no text (binary, compressed and truncated, ...). */
  note?: string;
}

export type RequestState = 'pending' | 'complete' | 'error' | 'aborted';

export interface CapturedRequest {
  id: string;
  /** Increases on every change; lets clients discard stale updates. */
  seq: number;
  proxy: string;
  proxyPort: number;
  method: string;
  /** Path and query as requested to the proxy. */
  path: string;
  /** Full upstream URL the request was forwarded to. */
  url: string;
  startedAt: string;
  state: RequestState;
  request: { headers: Headers; body?: CapturedBody };
  response?: { status: number; statusText: string; headers: Headers; body?: CapturedBody };
  /** Milliseconds since the proxy received the request. */
  timings: { ttfb?: number; total?: number };
  error?: string;
}

export interface RequestSummary {
  id: string;
  seq: number;
  proxy: string;
  proxyPort: number;
  method: string;
  path: string;
  url: string;
  startedAt: string;
  state: RequestState;
  status?: number;
  ttfb?: number;
  duration?: number;
  requestSize?: number;
  responseSize?: number;
  contentType?: string;
  error?: string;
}

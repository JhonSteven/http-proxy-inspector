import { EventEmitter } from 'node:events';
import type { CapturedRequest, RequestSummary } from './types';

export function summarize(entry: CapturedRequest): RequestSummary {
  const contentType = entry.response?.body?.contentType ?? headerValue(entry.response?.headers['content-type']);
  return {
    id: entry.id,
    seq: entry.seq,
    proxy: entry.proxy,
    proxyPort: entry.proxyPort,
    method: entry.method,
    path: entry.path,
    url: entry.url,
    startedAt: entry.startedAt,
    state: entry.state,
    status: entry.response?.status,
    ttfb: entry.timings.ttfb,
    duration: entry.timings.total,
    requestSize: entry.request.body?.size,
    responseSize: entry.response?.body?.size,
    contentType,
    mock: entry.mock,
    error: entry.error,
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * In-memory ring buffer of captured requests.
 *
 * Events: `update` (entry added or changed), `remove` (ids evicted), `clear`,
 * and `config` (the inspector reloaded its config).
 */
export class RequestStore extends EventEmitter {
  private readonly entries = new Map<string, CapturedRequest>();
  private seq = 0;

  constructor(private readonly maxEntries: number) {
    super();
    // Every open UI tab subscribes to these events.
    this.setMaxListeners(0);
  }

  get currentSeq(): number {
    return this.seq;
  }

  add(entry: Omit<CapturedRequest, 'seq'>): CapturedRequest {
    const stored = entry as CapturedRequest;
    stored.seq = ++this.seq;
    this.entries.set(stored.id, stored);

    const evicted: string[] = [];
    for (const id of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(id);
      evicted.push(id);
    }

    this.emit('update', stored);
    if (evicted.length > 0) this.emit('remove', evicted);
    return stored;
  }

  /** Publishes changes made to an entry. Ignored if the entry was evicted or cleared. */
  update(entry: CapturedRequest): void {
    if (this.entries.get(entry.id) !== entry) return;
    entry.seq = ++this.seq;
    this.emit('update', entry);
  }

  get(id: string): CapturedRequest | undefined {
    return this.entries.get(id);
  }

  list(): RequestSummary[] {
    return Array.from(this.entries.values(), summarize);
  }

  clear(): void {
    this.entries.clear();
    this.emit('clear');
  }
}

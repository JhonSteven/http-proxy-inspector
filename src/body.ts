import * as zlib from 'node:zlib';
import type { CapturedBody, Headers } from './types';

const TEXTUAL_TYPES = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|graphql|x-www-form-urlencoded|x-ndjson)\b|multipart\/form-data)/i;

type Decoder = (buffer: Buffer, options: zlib.ZlibOptions | zlib.BrotliOptions) => Buffer;

const DECODERS: Record<string, Decoder | undefined> = {
  gzip: zlib.gunzipSync,
  'x-gzip': zlib.gunzipSync,
  deflate: zlib.inflateSync,
  br: zlib.brotliDecompressSync,
  // Available from Node 22.15 / 23.8.
  zstd: (zlib as unknown as Record<string, Decoder | undefined>).zstdDecompressSync,
};

function firstHeader(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 1024);
  return !sample.includes(0);
}

/** Collects up to `limit` bytes of a body while it streams through the proxy. */
export class BodyCollector {
  private readonly chunks: Buffer[] = [];
  private captured = 0;
  private size = 0;
  private truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.size += chunk.length;
    const room = this.limit - this.captured;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(part);
    this.captured += part.length;
    if (part.length < chunk.length) this.truncated = true;
  }

  finish(headers: Headers): CapturedBody | undefined {
    if (this.size === 0) return undefined;

    const contentType = firstHeader(headers, 'content-type');
    const body: CapturedBody = { size: this.size, truncated: this.truncated, contentType };
    if (this.captured === 0) {
      body.note = 'Body capture is disabled (maxBodySize is 0).';
      return body;
    }
    let buffer: Buffer = Buffer.concat(this.chunks);

    const encoding = firstHeader(headers, 'content-encoding')?.trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      const decode = DECODERS[encoding];
      if (!decode) {
        body.note = `Body encoded with unsupported "${encoding}".`;
        return body;
      }
      if (this.truncated) {
        body.note = `Body is ${encoding}-compressed and larger than the capture limit, so it cannot be decoded.`;
        return body;
      }
      try {
        buffer = decode(buffer, { maxOutputLength: Math.max(this.limit * 4, 1024) });
      } catch {
        body.note = `Could not decode the ${encoding} body (corrupt or too large once decompressed).`;
        return body;
      }
      if (buffer.length > this.limit) {
        buffer = buffer.subarray(0, this.limit);
        body.truncated = true;
      }
    }

    const textual = contentType ? TEXTUAL_TYPES.test(contentType) : looksLikeText(buffer);
    if (!textual) {
      body.note = `Binary content${contentType ? ` (${contentType})` : ''}.`;
      return body;
    }

    body.text = buffer.toString('utf8');
    return body;
  }
}

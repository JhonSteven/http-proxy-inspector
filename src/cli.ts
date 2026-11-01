#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_FILES, ConfigError, findConfigFile, loadConfigFile, parseProxyFlag } from './config';
import { startInspector, type Inspector } from './inspector';
import type { CapturedRequest, InspectorConfig, ProxyConfig } from './types';
import { VERSION } from './version';

export interface CliOptions {
  init: boolean;
  config?: string;
  proxies: ProxyConfig[];
  uiPort?: number;
  noUi: boolean;
  host?: string;
  quiet: boolean;
  help: boolean;
  version: boolean;
  /** Command to run alongside the inspector (everything after `--`). */
  run: string[];
}

const HELP = `
🔭 http-proxy-inspector v${VERSION}

Local proxies that forward to your real APIs and show every request in a web UI.

Usage:
  http-proxy-inspector [options] [-- <command...>]
  http-proxy-inspector init

Options:
  -c, --config <file>     Config file (default: ${CONFIG_FILES[0]} or .js/.mjs/.cjs in the current folder)
  -p, --proxy <spec>      Add a proxy: <port>=<target> or <name>:<port>=<target> (repeatable)
      --ui-port <port>    Port for the web UI (default: 4000)
      --no-ui             Do not start the web UI
      --host <host>       Interface to bind (default: localhost)
  -q, --quiet             Do not log each request in the terminal
  -h, --help              Show this help
  -v, --version           Show the version

Examples:
  http-proxy-inspector init
  http-proxy-inspector -p 3001=https://jsonplaceholder.typicode.com
  http-proxy-inspector -p users:3001=https://api.users.com -p payments:3002=https://api.payments.com
  http-proxy-inspector -- next dev        # start the proxies, then your dev server
`;

const STARTER_CONFIG = {
  ui: { port: 4000 },
  proxies: [{ name: 'api', port: 3001, target: 'https://jsonplaceholder.typicode.com' }],
};

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { init: false, proxies: [], noUi: false, quiet: false, help: false, version: false, run: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      options.run = argv.slice(i + 1);
      break;
    }

    const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => {
      const next = inlineValue ?? argv[++i];
      if (next === undefined || (inlineValue === undefined && next.startsWith('-'))) {
        throw new ConfigError(`Missing value for ${flag}.`);
      }
      return next;
    };
    const port = () => {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) throw new ConfigError(`${flag} expects a port number (got "${raw}").`);
      return parsed;
    };

    switch (flag) {
      case 'init':
        if (i !== 0) throw new ConfigError('"init" must be the first argument.');
        options.init = true;
        break;
      case '-c':
      case '--config':
        options.config = value();
        break;
      case '-p':
      case '--proxy':
        options.proxies.push(parseProxyFlag(value()));
        break;
      case '--ui-port':
        options.uiPort = port();
        break;
      case '--no-ui':
        options.noUi = true;
        break;
      case '--host':
        options.host = value();
        break;
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        options.version = true;
        break;
      default:
        throw new ConfigError(`Unknown argument "${arg}". Run with --help to see the options.`);
    }
  }

  return options;
}

export async function buildConfig(options: CliOptions, cwd: string = process.cwd()): Promise<InspectorConfig> {
  const file = options.config ? resolve(cwd, options.config) : findConfigFile(cwd);
  if (!file && options.proxies.length === 0) {
    throw new ConfigError(
      'No config found. Run "http-proxy-inspector init" to create one, or pass --proxy 3001=https://api.example.com',
    );
  }

  const fromFile = file ? await loadConfigFile(file) : {};
  const fileProxies = Array.isArray(fromFile.proxies) ? fromFile.proxies : [];
  // A --proxy flag replaces a config proxy on the same port.
  const proxies = fileProxies.filter(proxy => !options.proxies.some(flag => flag.port === proxy?.port)).concat(options.proxies);

  return {
    ...fromFile,
    host: options.host ?? fromFile.host,
    ui: {
      ...fromFile.ui,
      ...(options.uiPort !== undefined ? { port: options.uiPort } : {}),
      ...(options.noUi ? { enabled: false } : {}),
    },
    proxies,
  };
}

function runInit(cwd: string = process.cwd()): void {
  const existing = findConfigFile(cwd);
  if (existing) {
    console.log(`A config file already exists: ${existing}`);
    return;
  }
  const file = resolve(cwd, CONFIG_FILES[0]);
  writeFileSync(file, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`);
  console.log(`Created ${file}

Next steps:
  1. Set each proxy's "target" to the real API and pick a free "port".
  2. Point your app at the proxy, e.g. API_URL=http://localhost:3001 in .env.development
  3. Run: npx http-proxy-inspector`);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

function printBanner(inspector: Inspector): void {
  const width = Math.max(...inspector.proxies.map(proxy => proxy.name.length));
  console.log(`\n🔭 ${paint(1, 'http-proxy-inspector')} v${VERSION}\n`);
  console.log('  Proxies');
  for (const proxy of inspector.proxies) {
    console.log(`    ${proxy.name.padEnd(width)}  ${paint(36, proxy.url)}  →  ${proxy.target}`);
  }
  if (inspector.uiUrl) console.log(`\n  UI  ${paint(36, inspector.uiUrl)}`);
  console.log(`\n  ${paint(2, 'Point your app at the proxy URLs. Press Ctrl+C to stop.')}\n`);
}

function logRequest(entry: CapturedRequest, nameWidth: number): void {
  if (entry.state === 'pending') return;
  const time = new Date(entry.startedAt).toLocaleTimeString('en-GB', { hour12: false });
  const status = entry.response?.status;
  const statusText =
    entry.state === 'complete' && status
      ? paint(status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32, String(status))
      : paint(31, entry.state === 'aborted' ? 'ABRT' : 'ERR ');
  const duration = entry.timings.total !== undefined ? `${Math.round(entry.timings.total)} ms` : '';
  const suffix = entry.error ? `  ${paint(31, entry.error)}` : '';
  console.log(
    `  ${paint(2, time)}  ${entry.proxy.padEnd(nameWidth)}  ${entry.method.padEnd(6)} ${statusText}  ${entry.path}  ${paint(2, duration)}${suffix}`,
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.help) return void console.log(HELP);
  if (options.version) return void console.log(VERSION);
  if (options.init) return runInit();

  const inspector = await startInspector(await buildConfig(options));
  printBanner(inspector);

  if (!options.quiet) {
    const nameWidth = Math.max(...inspector.proxies.map(proxy => proxy.name.length));
    inspector.store.on('update', (entry: CapturedRequest) => logRequest(entry, nameWidth));
  }

  let child: ChildProcess | undefined;
  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await inspector.close();
    process.exit(code);
  };

  if (options.run.length > 0) {
    const [command, ...args] = options.run;
    child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code, signal) => void shutdown(code ?? (signal ? 1 : 0)));
    child.on('error', error => {
      console.error(`Could not start "${command}": ${error.message}`);
      void shutdown(1);
    });
  }

  let interrupts = 0;
  process.on('SIGINT', () => {
    // The terminal also sends SIGINT to the child; wait for it to exit unless asked twice.
    if (child && child.exitCode === null && ++interrupts < 2) return;
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    else void shutdown(0);
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

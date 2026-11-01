'use strict';

const METHOD_FILTERS = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ERROR'];
const THEME_KEY = 'http-proxy-inspector-theme';
const TIMELINE_LIMIT = 150;
const JSON_PAGE = 200;

const state = {
  info: null,
  instance: null,
  /** id -> summary, in arrival order. */
  requests: new Map(),
  /** id -> { root, line, details } */
  rows: new Map(),
  /** id -> full captured request, loaded when a row is expanded. */
  details: new Map(),
  expanded: new Set(),
  tabs: new Map(),
  selected: null,
  filter: { method: 'ALL', proxy: 'ALL', search: '' },
  proxyChips: new Map(),
  methodButtons: new Map(),
};

const $ = id => document.getElementById(id);

/** Creates an element. Strings become text nodes, so captured data is never parsed as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Formatting

function formatTime(iso) {
  const date = new Date(iso);
  return `${date.toLocaleTimeString('en-GB', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatDuration(ms) {
  if (ms === undefined || ms === null) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isFailure(summary) {
  return summary.state === 'error' || summary.state === 'aborted' || (summary.status !== undefined && summary.status >= 400);
}

function statusClass(summary) {
  if (summary.state === 'error' || summary.state === 'aborted') return 'status-error';
  if (summary.status === undefined) return 'status-pending';
  return `status-${Math.min(Math.floor(summary.status / 100), 5)}xx`;
}

function statusLabel(summary) {
  if (summary.state === 'error') return 'ERR';
  if (summary.state === 'aborted') return 'ABRT';
  return summary.status === undefined ? '…' : String(summary.status);
}

function methodKind(summary) {
  if (isFailure(summary)) return 'error';
  const method = summary.method.toLowerCase();
  return ['get', 'post', 'put', 'patch', 'delete'].includes(method) ? method : 'other';
}

function headerPairs(headers) {
  return Object.entries(headers || {}).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map(item => [name, item]) : [[name, value]],
  );
}

// Filters

function matches(summary) {
  const { method, proxy, search } = state.filter;
  if (proxy !== 'ALL' && summary.proxy !== proxy) return false;
  if (method === 'ERROR' && !isFailure(summary)) return false;
  if (method !== 'ALL' && method !== 'ERROR' && summary.method !== method) return false;
  if (search && !summary.url.toLowerCase().includes(search) && !summary.path.toLowerCase().includes(search)) return false;
  return true;
}

function applyFilters() {
  for (const [id, row] of state.rows) row.root.hidden = !matches(state.requests.get(id));
  for (const [method, button] of state.methodButtons) button.classList.toggle('active', state.filter.method === method);
  scheduleRefresh();
}

function buildMethodFilters() {
  $('method-filters').replaceChildren(
    ...METHOD_FILTERS.map(method => {
      const button = h('button', {
        type: 'button',
        class: 'filter-btn',
        text: method,
        onclick: () => {
          state.filter.method = method;
          applyFilters();
        },
      });
      state.methodButtons.set(method, button);
      return button;
    }),
  );
}

function buildProxyChips() {
  state.proxyChips.clear();
  const chip = (key, name, route, title) => {
    const count = h('span', { class: 'proxy-count', text: '0' });
    const el = h(
      'button',
      {
        type: 'button',
        class: 'proxy-chip',
        title,
        onclick: () => {
          state.filter.proxy = key;
          applyFilters();
        },
      },
      h('span', { class: 'proxy-name', text: name }),
      route && h('span', { class: 'proxy-route', text: route }),
      count,
    );
    state.proxyChips.set(key, { el, count });
    return el;
  };

  const proxies = state.info ? state.info.proxies : [];
  if (state.filter.proxy !== 'ALL' && !proxies.some(proxy => proxy.name === state.filter.proxy)) state.filter.proxy = 'ALL';

  $('proxies').replaceChildren(
    chip('ALL', 'All proxies', null, 'Show requests from every proxy'),
    ...proxies.map(proxy =>
      chip(proxy.name, proxy.name, `:${proxy.port} → ${proxy.target.replace(/^https?:\/\//, '')}`, `${proxy.url} → ${proxy.target}`),
    ),
  );
}

function updateProxyChips() {
  const counts = new Map();
  for (const summary of state.requests.values()) counts.set(summary.proxy, (counts.get(summary.proxy) || 0) + 1);
  for (const [key, chip] of state.proxyChips) {
    chip.el.classList.toggle('active', state.filter.proxy === key);
    chip.count.textContent = String(key === 'ALL' ? state.requests.size : counts.get(key) || 0);
  }
}

// Request rows

function renderLine(summary) {
  return [
    h(
      'div',
      { class: 'network-url', title: summary.url },
      h('span', { class: `expand-icon${state.expanded.has(summary.id) ? ' expanded' : ''}`, text: '▶' }),
      h('span', { class: 'path', text: summary.path }),
    ),
    h('div', { class: 'network-proxy', text: summary.proxy, title: `localhost:${summary.proxyPort}` }),
    h('div', { class: `network-method method-${summary.method}${isFailure(summary) ? ' error' : ''}`, text: summary.method }),
    h('div', { class: `network-status ${statusClass(summary)}`, text: statusLabel(summary) }),
    h('div', { class: 'network-duration', text: summary.state === 'pending' ? '…' : formatDuration(summary.duration) }),
    h('div', { class: 'network-time', text: formatTime(summary.startedAt) }),
  ];
}

function ensureRow(summary) {
  let row = state.rows.get(summary.id);
  if (!row) {
    const id = summary.id;
    const line = h('div', {
      class: 'network-row',
      role: 'button',
      tabindex: '0',
      onclick: () => toggle(id),
      onkeydown: event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle(id);
        }
      },
    });
    const details = h('div', { class: 'network-details', hidden: true });
    row = { root: h('div', { class: 'network-item' }, line, details), line, details };
    state.rows.set(id, row);
    $('network-list').prepend(row.root);
  }
  row.line.replaceChildren(...renderLine(summary));
  row.root.classList.toggle('error-item', isFailure(summary));
  row.root.hidden = !matches(summary);
  return row;
}

function upsert(summary) {
  const current = state.requests.get(summary.id);
  if (current && current.seq >= summary.seq) return;
  state.requests.set(summary.id, summary);
  ensureRow(summary);
  const changed = !current || current.state !== summary.state || current.status !== summary.status;
  if (state.expanded.has(summary.id) && changed) loadDetails(summary.id);
  scheduleRefresh();
}

function remove(ids) {
  for (const id of ids) {
    state.rows.get(id)?.root.remove();
    state.rows.delete(id);
    state.requests.delete(id);
    state.details.delete(id);
    state.expanded.delete(id);
    state.tabs.delete(id);
    if (state.selected === id) state.selected = null;
  }
  scheduleRefresh();
}

function clearLocal() {
  remove([...state.requests.keys()]);
}

async function clearAll() {
  clearLocal();
  try {
    await fetch('/api/requests', { method: 'DELETE' });
  } catch (error) {
    console.error('Could not clear requests', error);
  }
}

function toggle(id) {
  const row = state.rows.get(id);
  const summary = state.requests.get(id);
  if (!row || !summary) return;

  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    row.details.hidden = true;
    if (state.selected === id) state.selected = null;
  } else {
    state.expanded.add(id);
    state.selected = id;
    row.details.hidden = false;
    const cached = state.details.get(id);
    if (cached && cached.seq === summary.seq) {
      renderDetails(id);
    } else {
      row.details.replaceChildren(h('div', { class: 'no-data', text: 'Loading…' }));
      loadDetails(id);
    }
  }
  row.line.replaceChildren(...renderLine(summary));
  scheduleRefresh();
}

function focusRequest(id) {
  const row = state.rows.get(id);
  if (!row) return;
  if (!state.expanded.has(id)) toggle(id);
  state.selected = id;
  row.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  row.root.classList.remove('highlight');
  void row.root.offsetWidth;
  row.root.classList.add('highlight');
  scheduleRefresh();
}

// Details

async function loadDetails(id) {
  try {
    const response = await fetch(`/api/requests/${encodeURIComponent(id)}`);
    const body = await response.json();
    const row = state.rows.get(id);
    if (!row) return;
    if (!response.ok) {
      row.details.replaceChildren(h('div', { class: 'no-data', text: body.error || 'Request not found.' }));
      return;
    }
    const cached = state.details.get(id);
    if (cached && cached.seq > body.seq) return;
    state.details.set(id, body);
    if (state.expanded.has(id)) renderDetails(id);
  } catch (error) {
    state.rows.get(id)?.details.replaceChildren(h('div', { class: 'error-message', text: `Could not load details: ${error.message}` }));
  }
}

function section(title, pairs) {
  if (pairs.length === 0) return null;
  return h(
    'div',
    { class: 'details-section' },
    h('div', { class: 'details-title', text: title }),
    h(
      'div',
      { class: 'details-content' },
      h(
        'div',
        { class: 'headers-grid' },
        pairs.flatMap(([key, value]) => [
          h('div', { class: 'header-key', text: key }),
          h('div', { class: 'header-value', text: value }),
        ]),
      ),
    ),
  );
}

function renderHeadersTab(entry) {
  let query = [];
  try {
    query = [...new URL(entry.url).searchParams.entries()];
  } catch (error) {
    query = [];
  }
  const response = entry.response;
  return h(
    'div',
    null,
    section('General', [
      ['Upstream URL', entry.url],
      ['Proxy', `${entry.proxy} (localhost:${entry.proxyPort})`],
      ['Method', entry.method],
      ['Status', response ? `${response.status} ${response.statusText}`.trim() : '—'],
      ['State', entry.state],
      ['Started', new Date(entry.startedAt).toLocaleString()],
      ['Time to first byte', formatDuration(entry.timings.ttfb) || '—'],
      ['Total time', formatDuration(entry.timings.total) || '—'],
      ['Request body', formatBytes(entry.request.body?.size) || '0 B'],
      ['Response body', formatBytes(response?.body?.size) || '0 B'],
    ]),
    section('Query parameters', query),
    section('Response headers', headerPairs(response?.headers)),
    section('Request headers', headerPairs(entry.request.headers)),
  );
}

function parseJson(body) {
  const text = body.text.trim();
  const declared = /json/i.test(body.contentType || '');
  if (!declared && !text.startsWith('{') && !text.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false };
  }
}

function jsonValue(value) {
  if (value === null) return h('span', { class: 'json-null', text: 'null' });
  switch (typeof value) {
    case 'string':
      return h('span', { class: 'json-string', text: JSON.stringify(value) });
    case 'number':
      return h('span', { class: 'json-number', text: String(value) });
    case 'boolean':
      return h('span', { class: 'json-boolean', text: String(value) });
    default:
      return h('span', { text: String(value) });
  }
}

/** Collapsible JSON tree. Children are built on first expand, in pages, so huge payloads stay fast. */
function jsonNode(value, level, key, isIndex) {
  const label =
    key === undefined
      ? []
      : [
          h('span', { class: isIndex ? 'json-index' : 'json-key', text: isIndex ? String(key) : JSON.stringify(key) }),
          h('span', { class: 'json-bracket', text: ': ' }),
        ];
  if (value === null || typeof value !== 'object') return h('div', { class: 'json-line' }, label, jsonValue(value));

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];
  if (entries.length === 0) return h('div', { class: 'json-line' }, label, h('span', { class: 'json-bracket', text: open + close }));

  let expanded = level < 2 && entries.length <= 100;
  let rendered = 0;
  const toggleButton = h('button', { type: 'button', class: 'json-toggle', 'aria-label': 'Expand or collapse' });
  const summary = h('span', { class: 'json-summary' });
  const children = h('div', { class: 'json-children' });
  const closing = h('div', { class: 'json-bracket json-close', text: close });

  const renderMore = () => {
    const page = entries.slice(rendered, rendered + JSON_PAGE);
    rendered += page.length;
    children.querySelector(':scope > .json-more')?.remove();
    children.append(...page.map(([childKey, childValue]) => jsonNode(childValue, level + 1, childKey, isArray)));
    const remaining = entries.length - rendered;
    if (remaining > 0) {
      children.append(h('button', { type: 'button', class: 'json-more', text: `Show ${Math.min(JSON_PAGE, remaining)} more (${remaining} left)`, onclick: renderMore }));
    }
  };

  const update = () => {
    toggleButton.textContent = expanded ? '▼' : '▶';
    children.hidden = !expanded;
    closing.hidden = !expanded;
    const noun = isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys';
    summary.textContent = expanded ? '' : ` ${entries.length} ${noun} ${close}`;
    if (expanded && rendered === 0) renderMore();
  };

  toggleButton.addEventListener('click', () => {
    expanded = !expanded;
    update();
  });
  update();

  return h(
    'div',
    { class: 'json-node' },
    h('div', { class: 'json-line' }, toggleButton, label, h('span', { class: 'json-bracket', text: open }), summary),
    children,
    closing,
  );
}

function formTable(text) {
  const pairs = [...new URLSearchParams(text).entries()];
  return h(
    'div',
    { class: 'details-content' },
    h('div', { class: 'headers-grid' }, pairs.flatMap(([key, value]) => [h('div', { class: 'header-key', text: key }), h('div', { class: 'header-value', text: value })])),
  );
}

function renderBody(body, emptyText) {
  if (!body) return h('div', { class: 'no-data', text: emptyText });

  const meta = [body.contentType || 'no content-type', formatBytes(body.size), body.truncated ? 'truncated' : null].filter(Boolean).join(' · ');
  const toolbar = h('div', { class: 'body-toolbar' }, h('span', { class: 'body-meta', text: meta }));
  if (body.text === undefined) {
    return h('div', { class: 'body-panel' }, toolbar, h('div', { class: 'details-content body-note', text: body.note || 'Body not available.' }));
  }

  const parsed = parseJson(body);
  const raw = h('pre', { class: 'details-content body-text', text: body.text });
  const isForm = !parsed.ok && /x-www-form-urlencoded/i.test(body.contentType || '');
  const pretty = parsed.ok ? h('div', { class: 'details-content json-viewer' }, jsonNode(parsed.value, 0)) : isForm ? formTable(body.text) : null;

  let showRaw = !pretty;
  const view = h('div');
  const viewToggle = pretty ? h('button', { type: 'button', class: 'action-btn' }) : null;
  const update = () => {
    view.replaceChildren(showRaw ? raw : pretty);
    if (viewToggle) viewToggle.textContent = showRaw ? (parsed.ok ? 'Tree' : 'Table') : 'Raw';
  };
  viewToggle?.addEventListener('click', () => {
    showRaw = !showRaw;
    update();
  });
  update();

  const copyText = parsed.ok ? JSON.stringify(parsed.value, null, 2) : body.text;
  toolbar.append(...[viewToggle, h('button', { type: 'button', class: 'action-btn', text: 'Copy', onclick: event => copy(event.currentTarget, copyText) })].filter(Boolean));

  const limit = state.info ? formatBytes(state.info.maxBodySize) : 'the limit';
  const truncatedNote = body.truncated
    ? h('div', { class: 'body-note', text: `Only the first ${limit} were captured. Raise "maxBodySize" in the config to capture more.` })
    : null;

  return h('div', { class: 'body-panel' }, toolbar, truncatedNote, view);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function toCurl(entry) {
  const parts = ['curl'];
  if (entry.method !== 'GET') parts.push('-X', entry.method);
  parts.push(shellQuote(entry.url));
  let compressed = false;
  for (const [name, value] of headerPairs(entry.request.headers)) {
    if (name === 'host' || name === 'content-length' || name === 'connection') continue;
    if (name === 'accept-encoding') {
      compressed = true;
      continue;
    }
    parts.push('-H', shellQuote(`${name}: ${value}`));
  }
  if (compressed) parts.push('--compressed');
  if (entry.request.body?.text !== undefined) parts.push('--data-raw', shellQuote(entry.request.body.text));
  return parts.join(' \\\n  ');
}

async function copy(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied!';
  } catch (error) {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function renderDetails(id) {
  const entry = state.details.get(id);
  const row = state.rows.get(id);
  if (!entry || !row) return;

  const tab = state.tabs.get(id) || 'headers';
  const tabs = [
    ['headers', 'Headers'],
    ['request', 'Request body'],
    ['response', 'Response body'],
  ];

  let content;
  if (tab === 'headers') content = renderHeadersTab(entry);
  else if (tab === 'request') content = renderBody(entry.request.body, 'No request body');
  else if (entry.response) content = renderBody(entry.response.body, entry.state === 'pending' ? 'Receiving the response…' : 'No response body');
  else content = h('div', { class: 'no-data', text: entry.state === 'pending' ? 'Waiting for the response…' : 'No response' });

  const header = h(
    'div',
    { class: 'tabs-header' },
    tabs.map(([key, label]) =>
      h('button', {
        type: 'button',
        class: `tab-button${tab === key ? ' active' : ''}`,
        text: label,
        onclick: () => {
          state.tabs.set(id, key);
          renderDetails(id);
        },
      }),
    ),
    h(
      'div',
      { class: 'tab-actions' },
      h('button', { type: 'button', class: 'action-btn', text: 'Copy as cURL', onclick: event => copy(event.currentTarget, toCurl(entry)) }),
    ),
  );

  const error = entry.error ? h('div', { class: 'error-message', text: entry.error }) : null;
  row.details.replaceChildren(...[error, h('div', { class: 'tabs-container' }, header, content)].filter(Boolean));
}


// Toolbar, stats and timeline

function renderStats(visible) {
  const done = visible.filter(summary => summary.state !== 'pending');
  const durations = done.map(summary => summary.duration).filter(duration => duration !== undefined);
  const ok = done.filter(summary => !isFailure(summary)).length;
  const errors = visible.filter(isFailure).length;
  const average = durations.length ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length : 0;
  const pending = visible.length - done.length;

  const stat = (value, label) => h('div', { class: 'stat-item' }, h('span', { class: 'stat-number', text: String(value) }), h('span', { text: label }));
  const items = [
    stat(visible.length, 'requests'),
    stat(`${ok}/${done.length}`, 'ok'),
    stat(errors, 'errors'),
    stat(formatDuration(average) || '0 ms', 'avg'),
  ];
  if (pending > 0) items.push(stat(pending, 'pending'));
  $('stats').replaceChildren(...items);
}

function renderTimeline(visible) {
  const items = visible.slice(-TIMELINE_LIMIT);
  const title = items.length < visible.length ? `Timeline (last ${items.length})` : 'Timeline';
  const header = h('div', { class: 'timeline-header' }, h('div', { class: 'timeline-title', text: title }));

  if (items.length === 0) {
    $('timeline').replaceChildren(header, h('div', { class: 'timeline-viewport' }, h('div', { class: 'timeline-empty', text: 'Waiting for requests…' })));
    return;
  }

  const now = Date.now();
  const startOf = summary => Date.parse(summary.startedAt);
  const endOf = summary => (summary.duration !== undefined ? startOf(summary) + summary.duration : now);
  const min = Math.min(...items.map(startOf));
  const span = Math.max(Math.max(...items.map(endOf)) - min, 1);

  const rows = items.map(summary => {
    const left = ((startOf(summary) - min) / span) * 100;
    const width = Math.max(((endOf(summary) - startOf(summary)) / span) * 100, 0.4);
    return h(
      'div',
      {
        class: `timeline-row${state.selected === summary.id ? ' selected' : ''}`,
        'data-id': summary.id,
        title: `${summary.method} ${summary.url} · ${formatDuration(endOf(summary) - startOf(summary))}`,
      },
      h('div', { class: 'timeline-row-label', text: `${summary.method} ${summary.path.split('?')[0]}` }),
      h(
        'div',
        { class: 'timeline-row-track' },
        h(
          'div',
          { class: 'timeline-track-inner' },
          h('div', {
            class: `timeline-request kind-${methodKind(summary)}${summary.state === 'pending' ? ' pending' : ''}`,
            style: { left: `${left}%`, width: `${width}%` },
          }),
        ),
      ),
      h('div', { class: 'timeline-row-duration', text: summary.state === 'pending' ? '…' : formatDuration(summary.duration) }),
    );
  });

  const legend = [
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
    ['other', 'OTHER'],
    ['error', 'ERROR'],
  ].map(([kind, label]) =>
    h('div', { class: 'timeline-legend-item' }, h('div', { class: `timeline-legend-color kind-${kind}` }), h('span', { text: label })),
  );

  $('timeline').replaceChildren(header, h('div', { class: 'timeline-viewport' }, rows), h('div', { class: 'timeline-legend' }, legend));
}

let refreshQueued = false;

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refresh();
  });
}

function refresh() {
  const visible = [...state.requests.values()].filter(matches);
  renderStats(visible);
  renderTimeline(visible);
  updateProxyChips();

  const empty = $('empty');
  empty.hidden = visible.length > 0;
  empty.textContent =
    state.requests.size === 0 ? 'Waiting for requests… point your app at one of the proxy URLs above.' : 'No requests match the current filters.';
}

// Theme

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function updateThemeButton() {
  $('theme-toggle').textContent = currentTheme() === 'dark' ? '☀️ Light' : '🌙 Dark';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (error) {
    // Storage can be unavailable (private mode); the toggle still works for this page.
  }
  updateThemeButton();
}

// Live connection

function setConnection(status) {
  const el = $('connection');
  el.dataset.state = status;
  el.querySelector('.label').textContent = status === 'connected' ? 'live' : status === 'reconnecting' ? 'reconnecting…' : 'disconnected';
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

/** Loads the current snapshot. Runs on every (re)connect so the page recovers from restarts. */
async function resync() {
  try {
    const [info, snapshot] = await Promise.all([fetchJson('/api/info'), fetchJson('/api/requests')]);
    if (state.instance !== snapshot.instance) {
      clearLocal();
      state.instance = snapshot.instance;
    }
    state.info = info;
    $('version').textContent = `v${info.version}`;
    buildProxyChips();

    const ids = new Set(snapshot.requests.map(summary => summary.id));
    remove([...state.requests.values()].filter(summary => !ids.has(summary.id) && summary.seq <= snapshot.seq).map(summary => summary.id));
    for (const summary of snapshot.requests) upsert(summary);
    scheduleRefresh();
  } catch (error) {
    console.error('Could not load requests', error);
  }
}

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => {
    setConnection('connected');
    resync();
  });
  source.addEventListener('error', () => {
    setConnection(source.readyState === EventSource.CLOSED ? 'disconnected' : 'reconnecting');
  });
  source.addEventListener('request', event => upsert(JSON.parse(event.data)));
  source.addEventListener('remove', event => remove(JSON.parse(event.data)));
  source.addEventListener('clear', () => clearLocal());
}

function init() {
  buildMethodFilters();
  applyFilters();
  updateThemeButton();

  $('search').addEventListener('input', event => {
    state.filter.search = event.target.value.trim().toLowerCase();
    applyFilters();
  });
  $('clear').addEventListener('click', clearAll);
  $('theme-toggle').addEventListener('click', toggleTheme);
  $('timeline').addEventListener('click', event => {
    const row = event.target.closest('.timeline-row');
    if (row) focusRequest(row.dataset.id);
  });

  // Pending requests keep growing on the timeline.
  setInterval(() => {
    for (const summary of state.requests.values()) {
      if (summary.state === 'pending') return scheduleRefresh();
    }
  }, 1000);

  connect();
}

init();

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => req('GET', '/api/me'),
  login: (username, password) => req('POST', '/api/login', { username, password }),
  logout: () => req('POST', '/api/logout'),
  elevate: (password) => req('POST', '/api/elevate', { password }),

  host: () => req('GET', '/api/host'),
  containers: () => req('GET', '/api/containers'),
  container: (id) => req('GET', `/api/containers/${encodeURIComponent(id)}`),
  containerAction: (id, action) => req('POST', `/api/containers/${id}/${action}`),

  systemDf: () => req('GET', '/api/system/df'),
  prune: (target) => req('POST', `/api/system/prune/${target}`),
  removeVolume: (name) => req('POST', '/api/system/volumes/remove', { name }),

  claude: () => req('GET', '/api/claude'),
  uninstallClaude: () => req('POST', '/api/claude/uninstall'),

  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  testNtfy: (ntfy) => req('POST', '/api/settings/ntfy/test', { ntfy }),
  alerts: () => req('GET', '/api/alerts'),
};

// Update streams plain text as it runs, so it needs the raw fetch reader.
export async function streamUpdate(id, onChunk) {
  const res = await fetch(`/api/containers/${id}/update`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Update failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

// Same streaming shape as the container update: plain text, as it happens.
export async function streamPost(url, onChunk) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
  if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

export function wsUrl(path, params = {}) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams(params).toString();
  return `${proto}//${location.host}${path}${qs ? `?${qs}` : ''}`;
}

// --- formatting helpers ----------------------------------------------------

export function bytes(n) {
  if (!n && n !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function duration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ago(ms) {
  return duration((Date.now() - ms) / 1000);
}

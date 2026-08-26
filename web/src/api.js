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

  composeProjects: () => req('GET', '/api/compose'),
  composeFile: (p) => req('GET', `/api/compose/file?path=${encodeURIComponent(p)}`),
  saveComposeFile: (path, content, mtimeMs) => req('PUT', '/api/compose/file', { path, content, mtimeMs }),
  composeBackups: (project) => req('GET', `/api/compose/backups?project=${encodeURIComponent(project)}`),
  composeBackup: (project, name) =>
    req('GET', `/api/compose/backup?project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`),

  claude: () => req('GET', '/api/claude'),
  uninstallClaude: () => req('POST', '/api/claude/uninstall'),

  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  testNtfy: (ntfy) => req('POST', '/api/settings/ntfy/test', { ntfy }),
  testRegistries: (registries) => req('POST', '/api/settings/registries/test', { registries }),
  // Returns { log, muted }: what was sent, and which scopes are muted right now.
  alerts: () => req('GET', '/api/alerts'),
};

// A failed stream never has usable output, so surface the reason rather than
// piping an error page into the log. The body may be JSON or plain text.
async function failure(res, fallback) {
  const text = await res.text().catch(() => '');
  try {
    return new Error(JSON.parse(text)?.error || fallback);
  } catch {
    return new Error(text.trim() || fallback);
  }
}

// Update streams plain text as it runs, so it needs the raw fetch reader.
export async function streamUpdate(id, onChunk) {
  const res = await fetch(`/api/containers/${encodeURIComponent(id)}/update`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) throw await failure(res, `Update failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
}

// Same streaming shape as the container update: plain text, as it happens.
export async function streamPost(url, onChunk, body) {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await failure(res, `Request failed (${res.status})`);
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

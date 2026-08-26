// Runtime settings store. Everything the user can change from the Settings
// page lives here, in a 0600 JSON file on the ./data volume — deliberately not
// in .env, so ntfy can be reconfigured without a redeploy.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULTS = {
  ntfy: {
    url: '',
    topic: '',
    auth: 'none', // none | token | basic
    token: '',
    username: '',
    password: '',
  },
  // Private registry logins, applied to every `docker` the panel runs.
  // Each entry is { server, username, password }; see registry.js.
  registries: [],
  alerts: {
    enabled: true,
    pollSeconds: 30,
    // Anti-spam knobs, same semantics as disk-alert.sh: don't re-send the same
    // alert until cooldown elapses, and don't declare recovery until the value
    // has dropped `hysteresis` points clear of the threshold.
    cooldownSeconds: 86400,
    hysteresis: 5,
    containerDown: true,
    containerUnhealthy: true,
    restartLoop: true,
    // An update stops and recreates containers on purpose. Alerts for the
    // scope being updated are held back while the compose run is in flight,
    // plus a grace period for the new container to settle.
    muteDuringUpdates: true,
    muteGraceSeconds: 180,
    // A slow loop (a few restarts an hour) never shows up as a spike between
    // two polls, so restarts are counted over a rolling window instead.
    restartThreshold: 3,
    restartWindowMinutes: 60,
    disk: { enabled: true, threshold: 85 },
    memory: { enabled: true, threshold: 90 },
    load: { enabled: true, threshold: 4 },
  },
};

const SECRET_FIELDS = [
  ['ntfy', 'token'],
  ['ntfy', 'password'],
];

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObject(v) && isObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

let cache = null;

function bootstrapFromEnv(settings) {
  // Only used on first run, when no settings file exists yet.
  const url = (process.env.NTFY_URL || '').trim();
  const topic = (process.env.NTFY_TOPIC || '').trim();
  const token = (process.env.NTFY_TOKEN || '').trim();
  if (!url && !topic && !token) return settings;
  return deepMerge(settings, {
    ntfy: {
      url,
      topic,
      token,
      auth: token ? 'token' : 'none',
    },
  });
}

export function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = deepMerge(DEFAULTS, raw);
  } catch {
    cache = bootstrapFromEnv(structuredClone(DEFAULTS));
    save(cache);
  }
  return cache;
}

export function save(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  fs.chmodSync(FILE, 0o600);
  cache = settings;
  return cache;
}

function hint(value) {
  return value ? `••••${value.slice(-4)}` : '';
}

// Secrets never travel back to the browser. The UI gets a "set / not set"
// flag plus a short hint so you can tell one token from another.
export function redact(settings) {
  const out = structuredClone(settings);
  for (const [section, field] of SECRET_FIELDS) {
    const value = settings[section]?.[field] || '';
    out[section][field] = '';
    out[section][`${field}Set`] = Boolean(value);
    out[section][`${field}Hint`] = hint(value);
  }
  out.registries = (settings.registries || []).map((r) => ({
    server: r.server || '',
    username: r.username || '',
    password: '',
    passwordSet: Boolean(r.password),
    passwordHint: hint(r.password || ''),
  }));
  return out;
}

// The UI always sends the whole list, so the stored passwords are re-matched by
// server name: an entry that comes back with a blank password keeps the one on
// disk, exactly like the single-secret fields above. Blank and duplicate server
// names are dropped rather than saved as unusable rows.
function mergeRegistries(current, incoming) {
  if (!Array.isArray(incoming)) return current || [];
  const stored = new Map((current || []).map((r) => [r.server, r]));
  const seen = new Set();
  const out = [];
  for (const raw of incoming) {
    const server = String(raw?.server || '').trim();
    if (!server || seen.has(server)) continue;
    seen.add(server);
    const sent = raw?.password;
    let password;
    if (sent === '__CLEAR__') password = '';
    else if (sent) password = String(sent);
    else password = stored.get(server)?.password || '';
    out.push({ server, username: String(raw?.username || '').trim(), password });
  }
  return out;
}

// An omitted or empty secret means "leave it alone"; the literal string
// __CLEAR__ (sent by the UI's Clear button) wipes it.
export function applyPatch(patch) {
  const current = load();
  const merged = deepMerge(current, patch);
  for (const [section, field] of SECRET_FIELDS) {
    const incoming = patch?.[section]?.[field];
    if (incoming === '__CLEAR__') merged[section][field] = '';
    else if (!incoming) merged[section][field] = current[section]?.[field] || '';
    delete merged[section][`${field}Set`];
    delete merged[section][`${field}Hint`];
  }
  merged.registries = mergeRegistries(current.registries, patch?.registries ?? current.registries);
  return save(merged);
}

// Fills in the saved password for entries the UI sent blank, so "Test" can
// check a stored credential the browser never receives.
export function withStoredPasswords(incoming) {
  return mergeRegistries(load().registries, incoming);
}

export const REPO_DIR = process.env.REPO_DIR || '/srv/docker';
export const HOSTNAME_FQDN = process.env.HOSTNAME_FQDN || 'docker-host';

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

// Secrets never travel back to the browser. The UI gets a "set / not set"
// flag plus a short hint so you can tell one token from another.
export function redact(settings) {
  const out = structuredClone(settings);
  for (const [section, field] of SECRET_FIELDS) {
    const value = settings[section]?.[field] || '';
    out[section][field] = '';
    out[section][`${field}Set`] = Boolean(value);
    out[section][`${field}Hint`] = value ? `••••${value.slice(-4)}` : '';
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
  return save(merged);
}

export const REPO_DIR = process.env.REPO_DIR || '/srv/docker';
export const HOSTNAME_FQDN = process.env.HOSTNAME_FQDN || 'docker-host';

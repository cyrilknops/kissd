// Alert mute. Pulling and recreating a container is *meant* to stop it, so the
// watcher must not page anyone about a stop the user just clicked. Anything
// that runs compose registers a mute for the scope it touches; the watcher
// checks that scope before it sends, and — just as importantly — leaves the
// container's pre-update state as the baseline, so a service that never comes
// back still alerts once the mute lifts.
//
// Mutes are keyed by container name and by compose project. Entries carry
// absolute deadlines and are written to the data volume, so a mute survives
// kissd replacing itself mid-update.
import fs from 'node:fs';
import path from 'node:path';
import * as settingsStore from './config.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'alert-mutes.json');

// A run that hangs must not silence the host forever.
const MAX_SECONDS = 30 * 60;
// A detached run (kissd updating itself) has no completion to wait for, so its
// mute is a fixed window rather than a held one.
export const DETACHED_SECONDS = 300;

export const containerKey = (name) => `container:${name}`;
export const projectKey = (project) => `project:${project}`;

// The keys a container is covered by: its own name and its compose project.
export function keysFor(container) {
  const keys = [containerKey(container.name)];
  const project = container.compose?.project;
  if (project) keys.push(projectKey(project));
  return keys;
}

// key -> { holds, until, floor }
//   holds  how many runs are in flight right now
//   until  hold-driven deadline: the safety cap while held, now + grace once released
//   floor  an explicit timed mute, independent of any hold
let entries = new Map();
let loaded = false;

function graceMs() {
  const s = settingsStore.load().alerts?.muteGraceSeconds;
  return Math.max(0, Number.isFinite(s) ? s : 180) * 1000;
}

function deadline(entry) {
  return Math.max(entry.until || 0, entry.floor || 0);
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = {};
    for (const [key, e] of entries) out[key] = { until: e.until, floor: e.floor };
    fs.writeFileSync(FILE, JSON.stringify(out), { mode: 0o600 });
  } catch {
    // Losing the file only costs us a notification about a container the user
    // was already watching update on screen.
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const cap = Date.now() + graceMs();
    for (const [key, e] of Object.entries(raw || {})) {
      // Nothing is in flight in a freshly started process, so a hold-driven
      // deadline is worth only its grace period. An explicit timed mute — the
      // detached self-update — keeps the window it was given.
      entries.set(key, { holds: 0, until: Math.min(e.until || 0, cap), floor: e.floor || 0 });
    }
  } catch {
    entries = new Map();
  }
  prune();
}

function prune(now = Date.now()) {
  for (const [key, e] of entries) {
    if (e.holds <= 0 && deadline(e) <= now) entries.delete(key);
  }
}

function entryFor(key) {
  const existing = entries.get(key);
  if (existing) return existing;
  const fresh = { holds: 0, until: 0, floor: 0 };
  entries.set(key, fresh);
  return fresh;
}

// Off by explicit setting only: an older settings.json that predates the
// option should still get the mute rather than the alert storm.
export function isEnabled() {
  return settingsStore.load().alerts?.muteDuringUpdates !== false;
}

// True if any of these keys is currently muted.
export function isMuted(keys) {
  if (!isEnabled()) return false;
  load();
  const now = Date.now();
  prune(now);
  return keys.some((k) => {
    const e = entries.get(k);
    return Boolean(e) && (e.holds > 0 || now < deadline(e));
  });
}

// Mutes the given keys for the duration of a run. The returned function ends
// the mute, but only after a grace period — a container recreated by compose
// often settles a few seconds after the command itself returns.
export function begin(keys, { maxSeconds = MAX_SECONDS } = {}) {
  load();
  const cap = Date.now() + maxSeconds * 1000;
  for (const key of keys) {
    const e = entryFor(key);
    e.holds += 1;
    e.until = Math.max(e.until, cap);
  }
  persist();

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const end = Date.now() + graceMs();
    for (const key of keys) {
      const e = entries.get(key);
      if (!e) continue;
      e.holds = Math.max(0, e.holds - 1);
      if (e.holds === 0) e.until = end;
    }
    prune();
    persist();
  };
}

// A mute with a fixed end, used where there is no run to hold: the compose run
// that replaces kissd itself is detached, so nothing here ever sees it finish.
export function muteFor(keys, seconds) {
  load();
  const until = Date.now() + Math.max(0, seconds) * 1000;
  for (const key of keys) {
    const e = entryFor(key);
    e.floor = Math.max(e.floor, until);
  }
  persist();
}

// What is muted right now, for the Settings page.
export function active() {
  if (!isEnabled()) return [];
  load();
  const now = Date.now();
  prune(now);
  return [...entries.entries()]
    .filter(([, e]) => e.holds > 0 || now < deadline(e))
    .map(([key, e]) => ({ key, running: e.holds > 0, until: deadline(e) }));
}

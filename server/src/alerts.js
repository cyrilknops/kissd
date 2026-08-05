// Alert watcher. Threshold alerts use the same anti-spam rules as
// disk-alert.sh: an alert re-sends only after `cooldownSeconds`, and recovery
// is declared only once the value drops `hysteresis` points clear of the
// threshold. Container alerts fire on state *transitions*, so a container you
// deliberately stopped doesn't nag forever.
import fs from 'node:fs';
import path from 'node:path';
import * as settingsStore from './config.js';
import * as dockerApi from './docker.js';
import * as host from './host.js';
import { send, isConfigured } from './ntfy.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'alert-state.json');

let state = { thresholds: {}, containers: {}, restarts: {}, restartAlerts: {} };
let timer = null;
let baselineTaken = false;

const log = [];
const LOG_MAX = 200;

function record(entry) {
  log.unshift({ ...entry, at: Date.now() });
  if (log.length > LOG_MAX) log.length = LOG_MAX;
}

export function recentAlerts() {
  return log;
}

function loadState() {
  try {
    state = {
      thresholds: {}, containers: {}, restarts: {}, restartAlerts: {},
      ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')),
    };
    baselineTaken = Object.keys(state.containers).length > 0;
  } catch {
    state = { thresholds: {}, containers: {}, restarts: {}, restartAlerts: {} };
  }
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // Losing alert state only costs us one duplicate notification.
  }
}

async function notify(settings, payload) {
  record({ title: payload.title, message: payload.message, priority: payload.priority });
  if (!isConfigured(settings)) return;
  try {
    await send(settings, payload);
  } catch (err) {
    record({ title: 'ntfy delivery failed', message: err.message, priority: 'high' });
  }
}

// Threshold check with hysteresis + cooldown. Returns nothing; sends directly.
async function checkThreshold(settings, key, { enabled, value, threshold, label, unit = '%' }) {
  if (!enabled) return;
  const now = Date.now();
  const prev = state.thresholds[key] || { status: 'ok', last: 0 };
  const cooldownMs = (settings.alerts.cooldownSeconds || 86400) * 1000;
  const hysteresis = settings.alerts.hysteresis ?? 5;

  if (value >= threshold) {
    const isNew = prev.status !== 'alert';
    if (isNew || now - prev.last >= cooldownMs) {
      await notify(settings, {
        title: `${label} at ${value.toFixed(1)}${unit}`,
        message: `${label} is ${value.toFixed(1)}${unit}, at or above the ${threshold}${unit} threshold.`,
        priority: 'high',
        tags: ['warning'],
      });
      state.thresholds[key] = { status: 'alert', last: now };
      saveState();
    }
  } else if (prev.status === 'alert' && value < threshold - hysteresis) {
    await notify(settings, {
      title: `${label} recovered`,
      message: `${label} is back down to ${value.toFixed(1)}${unit} (threshold ${threshold}${unit}).`,
      priority: 'default',
      tags: ['white_check_mark'],
    });
    state.thresholds[key] = { status: 'ok', last: 0 };
    saveState();
  }
}

async function checkContainers(settings, containers) {
  const cfg = settings.alerts;
  let dirty = false;

  for (const c of containers) {
    const prev = state.containers[c.name];
    const now = { state: c.state, health: c.health };

    // First run just establishes a baseline — no alert storm on startup.
    if (baselineTaken && prev) {
      if (cfg.containerDown && prev.state === 'running' && c.state !== 'running') {
        await notify(settings, {
          title: `${c.name} stopped`,
          message: `Container ${c.name} went from running to ${c.state}.\nImage: ${c.image}\nStatus: ${c.status}`,
          priority: 'urgent',
          tags: ['rotating_light'],
        });
      }
      if (cfg.containerDown && prev.state !== 'running' && c.state === 'running') {
        await notify(settings, {
          title: `${c.name} is back up`,
          message: `Container ${c.name} is running again.`,
          priority: 'default',
          tags: ['white_check_mark'],
        });
      }
      if (cfg.containerUnhealthy && prev.health !== 'unhealthy' && c.health === 'unhealthy') {
        await notify(settings, {
          title: `${c.name} is unhealthy`,
          message: `Container ${c.name} failed its healthcheck.\nStatus: ${c.status}`,
          priority: 'high',
          tags: ['warning'],
        });
      }
      if (cfg.containerUnhealthy && prev.health === 'unhealthy' && c.health === 'healthy') {
        await notify(settings, {
          title: `${c.name} is healthy again`,
          message: `Container ${c.name} passed its healthcheck.`,
          priority: 'default',
          tags: ['white_check_mark'],
        });
      }
    }

    state.containers[c.name] = now;
    dirty = true;
  }

  // Restart-loop detection over a rolling window. Comparing only against the
  // previous poll misses slow loops — a container restarting every few minutes
  // never shows a 3-restart jump between two 30s samples, yet it is still
  // looping. Keeping timestamped samples catches both speeds.
  if (cfg.restartLoop) {
    const now = Date.now();
    const windowMs = Math.max(1, cfg.restartWindowMinutes ?? 60) * 60 * 1000;
    const threshold = Math.max(1, cfg.restartThreshold ?? 3);
    const cooldownMs = (cfg.cooldownSeconds || 86400) * 1000;

    for (const c of containers.filter((x) => x.state === 'running')) {
      let info;
      try {
        info = await dockerApi.inspect(c.id);
      } catch {
        continue;
      }
      const count = info.RestartCount || 0;

      // Older state stored a bare number; drop it rather than misread it.
      const prev = Array.isArray(state.restarts[c.name]) ? state.restarts[c.name] : [];
      const history = [...prev, { at: now, count }].filter((s) => now - s.at <= windowMs);
      state.restarts[c.name] = history;
      dirty = true;

      const oldest = history[0];
      const delta = count - oldest.count;
      if (history.length < 2 || delta < threshold) continue;

      const lastAlert = state.restartAlerts?.[c.name] || 0;
      if (now - lastAlert < cooldownMs) continue;

      const minutes = Math.max(1, Math.round((now - oldest.at) / 60000));
      await notify(settings, {
        title: `${c.name} is restart-looping`,
        message: `Container ${c.name} restarted ${delta} times in the last ${minutes} min (${count} since it was created).`,
        priority: 'urgent',
        tags: ['rotating_light'],
      });
      state.restartAlerts = { ...(state.restartAlerts || {}), [c.name]: now };
    }
  }

  if (dirty) saveState();
}

async function tick() {
  const settings = settingsStore.load();
  if (!settings.alerts?.enabled) return;

  try {
    const [containers, snap] = await Promise.all([dockerApi.list(), host.snapshot()]);

    await checkContainers(settings, containers);
    baselineTaken = true;

    const a = settings.alerts;
    await checkThreshold(settings, 'memory', {
      enabled: a.memory?.enabled,
      value: snap.memory.percent,
      threshold: a.memory?.threshold ?? 90,
      label: 'Memory usage',
    });
    await checkThreshold(settings, 'load', {
      enabled: a.load?.enabled,
      value: snap.load.one,
      threshold: a.load?.threshold ?? 4,
      label: 'Load average (1m)',
      unit: '',
    });
    if (a.disk?.enabled) {
      for (const d of snap.disks) {
        await checkThreshold(settings, `disk:${d.mountPoint}`, {
          enabled: true,
          value: d.percent,
          threshold: a.disk.threshold ?? 85,
          label: `Disk ${d.mountPoint}`,
        });
      }
    }
  } catch (err) {
    record({ title: 'Alert check failed', message: err.message, priority: 'high' });
  }
}

export function start() {
  loadState();
  const schedule = () => {
    const settings = settingsStore.load();
    const seconds = Math.max(10, settings.alerts?.pollSeconds || 30);
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, seconds * 1000);
  };
  // Take the baseline promptly, then settle into the configured interval.
  setTimeout(async () => {
    await tick();
    schedule();
  }, 5000);
}

export function stop() {
  if (timer) clearTimeout(timer);
}

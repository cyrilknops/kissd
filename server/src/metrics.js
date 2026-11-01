import path from 'node:path';
import * as settings from './config.js';
import * as docker from './docker.js';
import * as host from './host.js';
import { MetricsStore } from './metrics-store.js';
import { MetricsCollector } from './metrics-collector.js';

let store;
let collector;
export function start() {
  store = new MetricsStore(path.join(process.env.DATA_DIR || '/data', 'metrics.sqlite'));
  collector = new MetricsCollector({ store, snapshot: host.snapshot, list: docker.list, stats: docker.refreshStats, settings: settings.load });
  collector.start();
}
export function history(query) {
  if (!store) throw new Error('Metrics storage is unavailable');
  return { ...store.history({ ...query, retentionDays: settings.load().metrics.retentionDays }), collector: { lastSampleAt: collector.lastSampleAt, error: collector.error } };
}
export function prune() { store?.prune(settings.load().metrics.retentionDays); }
export async function stop() {
  await collector?.stop();
  store?.close();
}

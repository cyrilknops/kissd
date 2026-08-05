// Thin ntfy client. Server URL, topic and auth all come from runtime settings,
// so they can be changed from the Settings page without a redeploy.
import { HOSTNAME_FQDN } from './config.js';

export function isConfigured(settings) {
  const { url, topic } = settings.ntfy || {};
  return Boolean(url && topic);
}

function endpoint(ntfy) {
  return `${ntfy.url.replace(/\/+$/, '')}/${encodeURIComponent(ntfy.topic)}`;
}

function authHeader(ntfy) {
  if (ntfy.auth === 'token' && ntfy.token) return `Bearer ${ntfy.token}`;
  if (ntfy.auth === 'basic' && ntfy.username) {
    return `Basic ${Buffer.from(`${ntfy.username}:${ntfy.password || ''}`).toString('base64')}`;
  }
  return null;
}

export async function send(settings, { title, message, priority = 'default', tags = [] }) {
  const ntfy = settings.ntfy || {};
  if (!isConfigured(settings)) throw new Error('ntfy is not configured');

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: `[${HOSTNAME_FQDN}] ${title}`,
    Priority: priority,
  };
  if (tags.length) headers.Tags = tags.join(',');
  const auth = authHeader(ntfy);
  if (auth) headers.Authorization = auth;

  const url = endpoint(ntfy);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: message,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    // fetch() collapses DNS, TLS and connection failures into "fetch failed",
    // which is useless in a UI. Surface the underlying cause instead.
    const cause = err.cause?.code || err.cause?.message || err.name;
    if (err.name === 'TimeoutError') throw new Error(`No response from ${url} within 15s`);
    if (cause === 'ENOTFOUND') throw new Error(`Cannot resolve the hostname in ${url}`);
    if (cause === 'ECONNREFUSED') throw new Error(`Connection refused by ${url}`);
    if (cause === 'CERT_HAS_EXPIRED') throw new Error(`The TLS certificate for ${url} has expired`);
    throw new Error(`Could not reach ${url}${cause ? ` (${cause})` : ''}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 || res.status === 403
      ? ' — check the authentication settings'
      : '';
    throw new Error(`ntfy responded ${res.status} ${res.statusText}${hint}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return true;
}

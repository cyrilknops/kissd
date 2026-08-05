// Single-admin auth. The password is hashed at boot and never written to disk.
// Two token tiers: a normal session, and a short-lived "elevated" token that
// only the host shell requires.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as cookieLib from 'cookie';

const USER = process.env.KISSD_ADMIN_USER || 'admin';
const PASSWORD = process.env.KISSD_ADMIN_PASSWORD || '';
const SECRET = process.env.KISSD_JWT_SECRET || '';

export const SESSION_COOKIE = 'kissd_session';
export const ELEVATED_COOKIE = 'kissd_elevated';

const SESSION_TTL = '12h';
const ELEVATED_TTL = '5m';

if (!PASSWORD) throw new Error('KISSD_ADMIN_PASSWORD is not set');
if (!SECRET) throw new Error('KISSD_JWT_SECRET is not set');

const HASH = bcrypt.hashSync(PASSWORD, 12);

// Simple in-memory throttle. Resets on restart, which is fine for one admin.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function throttleKey(req) {
  return req.ip || 'unknown';
}

export function rateLimited(req) {
  const rec = attempts.get(throttleKey(req));
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(throttleKey(req));
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const key = throttleKey(req);
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

export function verifyCredentials(req, username, password) {
  const userOk = username === USER;
  // Always run the compare so a wrong username isn't measurably faster.
  const passOk = bcrypt.compareSync(password || '', HASH);
  if (userOk && passOk) {
    attempts.delete(throttleKey(req));
    return true;
  }
  recordFailure(req);
  return false;
}

export function issueSession(res) {
  const token = jwt.sign({ sub: USER, tier: 'session' }, SECRET, { expiresIn: SESSION_TTL });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });
}

export function issueElevated(res) {
  const token = jwt.sign({ sub: USER, tier: 'elevated' }, SECRET, { expiresIn: ELEVATED_TTL });
  res.cookie(ELEVATED_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 5 * 60 * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(ELEVATED_COOKIE, { path: '/' });
}

function verify(token, tier) {
  try {
    const payload = jwt.verify(token, SECRET);
    return payload.tier === tier ? payload : null;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  if (verify(req.cookies?.[SESSION_COOKIE], 'session')) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

export function requireElevated(req, res, next) {
  if (!verify(req.cookies?.[SESSION_COOKIE], 'session')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!verify(req.cookies?.[ELEVATED_COOKIE], 'elevated')) {
    return res.status(403).json({ error: 'Re-authentication required', needsElevation: true });
  }
  return next();
}

// WebSocket upgrades carry the same cookies as a normal same-origin request.
export function authFromUpgrade(req, { elevated = false } = {}) {
  const cookies = cookieLib.parse(req.headers.cookie || '');
  if (!verify(cookies[SESSION_COOKIE], 'session')) return false;
  if (elevated && !verify(cookies[ELEVATED_COOKIE], 'elevated')) return false;
  return true;
}

export const adminUser = USER;

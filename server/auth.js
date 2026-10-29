import crypto from 'node:crypto';

export const SESSION_COOKIE = 'miniplanner_sid';
export const DEFAULT_SESSION_TTL_SEC = 60 * 60 * 24; // 24 hours
export const REMEMBER_SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

/* ---------- Password Hashing (scrypt) ---------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/* ---------- Session Tokens & Cookies ---------- */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function generateSessionToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashToken(token),
  };
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function parseSessionToken(req) {
  const authHeader = req.headers?.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  const cookies = parseCookies(req.headers?.cookie || '');
  return cookies[SESSION_COOKIE] || null;
}

export function serializeSessionCookie(token, maxAgeSec = DEFAULT_SESSION_TTL_SEC) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseDevice(userAgent = '') {
  const ua = String(userAgent);
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/i.test(ua)
        ? 'macOS'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Device';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Chrome\//i.test(ua)
      ? 'Chrome'
      : /Firefox\//i.test(ua)
        ? 'Firefox'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${os} · ${browser}`;
}

/* ---------- Two-Factor Authentication (TOTP + Recovery Codes) ---------- */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function fromBase32(str) {
  const clean = String(str)
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function computeTotp(secretBase32, counter = Math.floor(Date.now() / 30_000)) {
  const key = fromBase32(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function generateRecoveryCodes(count = 6) {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const codes = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(8);
    const part1 = Array.from(bytes.slice(0, 4), b => chars[b % chars.length]).join('');
    const part2 = Array.from(bytes.slice(4, 8), b => chars[b % chars.length]).join('');
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

export function generateTotpSetup() {
  const secret = toBase32(crypto.randomBytes(20));
  const recoveryCodes = generateRecoveryCodes(6);
  return { secret, recoveryCodes };
}

export function verifyTotpOrRecovery(secret, recoveryCodes = [], rawCode = '') {
  const code = String(rawCode).trim().toUpperCase();
  if (!code) return { valid: false, recoveryCodes };

  if (/^\d{6}$/.test(code) && secret) {
    const step = Math.floor(Date.now() / 30_000);
    for (const delta of [-1, 0, 1]) {
      if (computeTotp(secret, step + delta) === code) {
        return { valid: true, usedRecovery: false, recoveryCodes };
      }
    }
  }

  const idx = recoveryCodes.findIndex(c => String(c).toUpperCase() === code);
  if (idx >= 0) {
    const nextCodes = recoveryCodes.filter((_, i) => i !== idx);
    return { valid: true, usedRecovery: true, recoveryCodes: nextCodes };
  }

  return { valid: false, recoveryCodes };
}

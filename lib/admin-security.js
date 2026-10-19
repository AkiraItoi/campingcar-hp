const crypto = require('node:crypto');

const ALLOWED = new Set(['sunaid20220708@gmail.com', 'info@izutrip.com']);
const COOKIE = '__Host-sunaid-admin';
const LOGIN_COOKIE = '__Host-sunaid-login';
function fail(code, status = 400) {
  const error = new Error(code); error.status = status; throw error;
}
function secret() {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value || value.length < 32) fail('CONFIG_REQUIRED', 503);
  return value;
}
function equal(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function decode(token, purpose) {
  if (typeof token !== 'string' || token.length > 4096) fail('AUTH_REQUIRED', 401);
  const parts = token.split('.');
  if (parts.length !== 2 || !equal(parts[1], crypto.createHmac('sha256', secret()).update(parts[0]).digest('base64url'))) fail('AUTH_REQUIRED', 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { fail('AUTH_REQUIRED', 401); }
  if (payload.purpose !== purpose || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) fail('AUTH_REQUIRED', 401);
  return payload;
}
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p.length === 2));
}
function cookie(name, value, age) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}
function session(req) {
  const value = decode(cookies(req)[COOKIE], 'session');
  if (!ALLOWED.has(value.email) || !value.sub || !value.csrf) fail('FORBIDDEN', 403);
  return value;
}
function origin(req) {
  const expected = process.env.ADMIN_ORIGIN;
  if (!expected || !/^https:\/\/[^/]+$/.test(expected)) fail('CONFIG_REQUIRED', 503);
  if (req.headers.origin !== expected) fail('ORIGIN_REJECTED', 403);
}
function csrf(req, user) {
  origin(req);
  if (!equal(req.headers['x-admin-csrf'], user.csrf)) fail('CSRF_REJECTED', 403);
}
function ready() {
  return Boolean(process.env.ADMIN_GOOGLE_CLIENT_ID && process.env.ADMIN_SESSION_SECRET?.length >= 32 &&
    process.env.ADMIN_BACKEND_SECRET?.length >= 32 && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(process.env.ADMIN_BACKEND_URL || '') &&
    /^https:\/\/[^/]+$/.test(process.env.ADMIN_ORIGIN || ''));
}
async function backend(action, data, user) {
  if (!ready()) fail('CONFIG_REQUIRED', 503);
  const payload = JSON.stringify({action, data, actor: user.email, timestamp: Date.now(), nonce: crypto.randomUUID()});
  const signature = crypto.createHmac('sha256', process.env.ADMIN_BACKEND_SECRET).update(payload).digest('hex');
  let response;
  try {
    response = await fetch(process.env.ADMIN_BACKEND_URL, {method: 'POST', redirect: 'follow',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({payload, signature}), signal: AbortSignal.timeout(25000)});
  } catch { fail(['send', 'sendTest', 'confirmReservation'].includes(action) ? 'ACTION_RESULT_UNKNOWN' : 'BACKEND_UNAVAILABLE', 502); }
  let result;
  try { result = await response.json(); } catch { fail('BACKEND_UNAVAILABLE', 502); }
  if (!response.ok || !result.ok) fail(result.error || 'BACKEND_UNAVAILABLE', result.status || 502);
  return result.data;
}
async function publicAvailability() {
  const url = process.env.ADMIN_BACKEND_URL;
  const backendSecret = process.env.ADMIN_BACKEND_SECRET;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url || '') || !backendSecret || backendSecret.length < 32) fail('CONFIG_REQUIRED', 503);
  const payload = JSON.stringify({action:'availability', data:{}, actor:'sunaid20220708@gmail.com', timestamp:Date.now(), nonce:crypto.randomUUID()});
  const signature = crypto.createHmac('sha256', backendSecret).update(payload).digest('hex');
  let response;
  try {
    response = await fetch(url, {method:'POST', redirect:'follow', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({payload, signature}), signal:AbortSignal.timeout(12000)});
  } catch { fail('BACKEND_UNAVAILABLE', 502); }
  let result;
  try { result = await response.json(); } catch { fail('BACKEND_UNAVAILABLE', 502); }
  if (!response.ok || !result.ok || !Array.isArray(result.data)) fail(result.error || 'BACKEND_UNAVAILABLE', result.status || 502);
  // Whitelist fields at the public boundary even if the private backend changes later.
  return result.data.map(item => ({start:item.start, end:item.end}));
}
module.exports = {ALLOWED, COOKIE, LOGIN_COOKIE, fail, equal, sign, decode, cookies, cookie, session, origin, csrf, ready, backend, publicAvailability};

'use strict';

/**
 * Speakeasy gate for the Los Barriles trip guide.
 *
 * One shared passcode, supplied as an environment variable, unlocks the whole
 * site. Nothing under index.html or public/ is served until the caller presents
 * a valid session cookie, so the itinerary and flight details never reach an
 * unauthenticated browser.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- config ---

const PORT = Number(process.env.PORT || 8080);
const PASSCODE = process.env.SITE_PASSCODE;
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();

// Max failed attempts from one IP before it is locked out for a while.
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 8);
const LOCKOUT_MINUTES = Number(process.env.LOCKOUT_MINUTES || 15);

if (!PASSCODE || !PASSCODE.trim()) {
  console.error('FATAL: SITE_PASSCODE is not set. Refusing to start an unprotected site.');
  process.exit(1);
}
if (PASSCODE.length < 6) {
  console.error('FATAL: SITE_PASSCODE must be at least 6 characters.');
  process.exit(1);
}

// Without a stable secret, every restart invalidates everyone's session.
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('WARN: SESSION_SECRET not set; generated a random one. ' +
    'Guests will be asked for the passcode again after each restart.');
}

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// Assets the login screen itself needs, before anyone is authenticated.
const PRE_AUTH_ASSETS = new Set(['/public/ignite_logo_full.png']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- session ---

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function issueToken() {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return exp + '.' + sign(exp);
}

function tokenIsValid(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9]{1,15}$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;

  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

// Hash both sides so the comparison is constant-time regardless of length.
function passcodeMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(PASSCODE).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function wantsSecureCookie(req) {
  if (COOKIE_SECURE === 'true') return true;
  if (COOKIE_SECURE === 'false') return false;
  // auto: trust the proxy's protocol header when present.
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAgeSeconds) {
  const bits = [
    'ignite_session=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds,
  ];
  if (wantsSecureCookie(req)) bits.push('Secure');
  return bits.join('; ');
}

// ------------------------------------------------------------ rate limits ---

const attempts = new Map(); // ip -> { count, lockedUntil }

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function lockRemaining(ip) {
  const rec = attempts.get(ip);
  if (!rec || !rec.lockedUntil) return 0;
  const left = rec.lockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 60000) : 0;
}

function recordFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60000;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) {
    if (!rec.lockedUntil || rec.lockedUntil < now) {
      if (rec.count === 0) attempts.delete(ip);
    }
  }
}, 10 * 60000).unref();

// ------------------------------------------------------------- login page ---

function loginPage({ error, next }) {
  const nextField = next
    ? '<input type="hidden" name="next" value="' + escapeHtml(next) + '">'
    : '';
  const banner = error
    ? '<p class="err" role="alert">' + escapeHtml(error) + '</p>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Los Barriles Bootcamp — Enter passcode</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#093442">
<link rel="icon" type="image/png" href="/public/ignite_logo_full.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100svh;
    display: grid;
    place-items: center;
    padding: 24px;
    font-family: 'Figtree', system-ui, -apple-system, sans-serif;
    color: #fff;
    background:
      radial-gradient(120% 90% at 82% -10%, rgba(245,160,30,0.30), transparent 55%),
      linear-gradient(160deg, #06232e, #0a3d4f 55%, #12697f);
  }
  .box { width: 100%; max-width: 380px; text-align: center; }
  .logo { width: clamp(140px, 44vw, 190px); height: auto; margin: 0 auto 22px; display: block; }
  h1 {
    font-family: 'Bricolage Grotesque', 'Figtree', sans-serif;
    font-size: clamp(1.5rem, 6vw, 1.9rem);
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.015em;
  }
  .sub { margin-top: 8px; color: #79c6d0; font-size: 0.96rem; line-height: 1.5; }
  form { margin-top: 24px; display: flex; flex-direction: column; gap: 10px; }
  label { text-align: left; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #79c6d0; }
  input {
    font: inherit;
    font-size: 1.05rem;
    padding: 14px 16px;
    min-height: 52px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.22);
    background: rgba(255,255,255,0.10);
    color: #fff;
    width: 100%;
  }
  input::placeholder { color: rgba(255,255,255,0.45); }
  input:focus-visible, button:focus-visible { outline: 3px solid #f5a01e; outline-offset: 2px; }
  button {
    font: inherit;
    font-weight: 700;
    font-size: 1rem;
    min-height: 52px;
    border: 0;
    border-radius: 12px;
    background: #f5a01e;
    color: #06232e;
    cursor: pointer;
  }
  button:hover { background: #ffb43d; }
  .err {
    margin-top: 16px;
    background: rgba(229,68,109,0.16);
    border: 1px solid rgba(229,68,109,0.5);
    color: #ffd3de;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 0.92rem;
    line-height: 1.45;
  }
  .foot { margin-top: 22px; font-size: 0.84rem; color: rgba(255,255,255,0.55); line-height: 1.5; }
</style>
</head>
<body>
  <main class="box">
    <img class="logo" src="/public/ignite_logo_full.png" alt="Ignite! Pickleball Global Excursions">
    <h1>Los Barriles Bootcamp</h1>
    <p class="sub">This trip guide is private. Enter the passcode your hosts shared with you.</p>
    ${banner}
    <form method="POST" action="/login" autocomplete="on">
      ${nextField}
      <label for="passcode">Access code</label>
      <input id="passcode" name="passcode" type="password" inputmode="text"
             autocomplete="current-password" autofocus required maxlength="200"
             placeholder="Enter passcode">
      <button type="submit">Unlock the week</button>
    </form>
    <p class="foot">Trouble getting in? Message Nicolas &amp; Jenny.</p>
  </main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- helpers ---

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function send(res, status, body, headers) {
  securityHeaders(res);
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  res.writeHead(status);
  res.end(body);
}

function sendHtml(res, status, html, extra) {
  send(res, status, html, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    // Never let a gated page sit in a shared or back-button cache.
    'Cache-Control': 'no-store, must-revalidate',
  }, extra || {}));
}

function redirect(res, location, extra) {
  send(res, 302, '', Object.assign({ Location: location, 'Cache-Control': 'no-store' }, extra || {}));
}

// Only ever resolve to index.html or something inside public/.
function resolveAsset(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  if (decoded === '/' || decoded === '/index.html') return path.join(ROOT, 'index.html');
  if (!decoded.startsWith('/public/')) return null;

  const full = path.resolve(ROOT, '.' + decoded);
  // path.resolve collapses any ../, so this prefix check is the real guard.
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return null;
  return full;
}

function serveAsset(req, res, file, isAuthed) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendHtml(res, 404, '<h1>404</h1>', { 'Content-Type': 'text/html; charset=utf-8' });

    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
    };
    // The page itself must not be cached; photos may be, but privately.
    headers['Cache-Control'] = ext === '.html'
      ? 'no-store, must-revalidate'
      : (isAuthed ? 'private, max-age=3600' : 'public, max-age=3600');

    securityHeaders(res);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
    res.writeHead(200);
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limitBytes, cb) {
  let size = 0;
  const chunks = [];
  let done = false;
  req.on('data', (c) => {
    if (done) return;
    size += c.length;
    if (size > limitBytes) { done = true; cb(new Error('too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks).toString('utf8')); } });
  req.on('error', () => { if (!done) { done = true; cb(new Error('read error')); } });
}

// Accept only same-site local paths as a post-login destination.
function safeNext(value) {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.includes('\\')) return '/';
  return value;
}

// ----------------------------------------------------------------- server ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;
  const cookies = parseCookies(req.headers.cookie);
  const authed = tokenIsValid(cookies.ignite_session);

  // ---- logout
  if (pathname === '/logout') {
    return redirect(res, '/', { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // ---- login submission
  if (pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const locked = lockRemaining(ip);
    if (locked > 0) {
      return sendHtml(res, 429, loginPage({
        error: 'Too many attempts. Try again in about ' + locked + ' minute' + (locked === 1 ? '' : 's') + '.',
      }));
    }

    // Reject cross-site form posts.
    const origin = req.headers.origin;
    if (origin && origin !== url.origin) {
      return sendHtml(res, 403, loginPage({ error: 'Request blocked. Please try again from this page.' }));
    }

    return readBody(req, 2048, (err, body) => {
      if (err) return sendHtml(res, 400, loginPage({ error: 'That request was malformed.' }));

      const form = new URLSearchParams(body || '');
      const next = safeNext(form.get('next'));

      if (!passcodeMatches(form.get('passcode') || '')) {
        recordFailure(ip);
        const still = lockRemaining(ip);
        return sendHtml(res, 401, loginPage({
          error: still > 0
            ? 'Too many attempts. Try again in about ' + still + ' minute' + (still === 1 ? '' : 's') + '.'
            : 'That passcode is not right.',
          next,
        }));
      }

      attempts.delete(ip);
      const maxAge = SESSION_DAYS * 86400;
      return redirect(res, next, { 'Set-Cookie': sessionCookie(req, issueToken(), maxAge) });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendHtml(res, 405, '<h1>405</h1>', { Allow: 'GET, HEAD, POST' });
  }

  // ---- login page (already-authed guests skip it)
  if (pathname === '/login') {
    if (authed) return redirect(res, '/');
    return sendHtml(res, 200, loginPage({ next: safeNext(url.searchParams.get('next')) }));
  }

  const file = resolveAsset(pathname);
  if (!file) return sendHtml(res, 404, '<h1>404</h1>');

  // ---- the gate
  if (!authed) {
    if (PRE_AUTH_ASSETS.has(pathname)) return serveAsset(req, res, file, false);
    const next = pathname === '/' ? '' : '?next=' + encodeURIComponent(pathname);
    return redirect(res, '/login' + next);
  }

  return serveAsset(req, res, file, true);
});

server.listen(PORT, () => {
  console.log('Trip guide listening on http://localhost:' + PORT);
  console.log('Passcode gate active. Sessions last ' + SESSION_DAYS + ' day(s).');
});

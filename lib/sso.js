import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { verifyIapAssertion } from './iap.js';

const COOKIE_NAME = 'sso_token';

export const TOKEN_TYPE_SESSION = 'session';
export const TOKEN_TYPE_STATE = 'oauth_state';

let secretWarned = false;

// Prefers base64 (how the secret is meant to be generated) but falls back to the
// raw UTF-8 bytes so a passphrase-style secret still yields a usable key rather
// than preventing startup. Both interpretations feed the same HKDF-style
// derivation below, so signing and verification can never disagree.
export function secretBytes() {
  const raw = String(cfg.ssoSecret || '').replace(/\s/g, '');
  const decoded = Buffer.from(raw, 'base64');
  const isBase64 = decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '');
  const chosen = isBase64 ? decoded : Buffer.from(raw, 'utf8');
  if (!secretWarned && (!isBase64 || decoded.length < 32)) {
    secretWarned = true;
    console.warn(
      `WARNING: SSO_SHARED_SECRET is weak (${isBase64 ? `${decoded.length} base64 bytes` : 'not base64'}). ` +
        'Rotate to 32+ random bytes: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return chosen;
}

export function secretStrength() {
  const raw = String(cfg.ssoSecret || '').replace(/\s/g, '');
  const decoded = Buffer.from(raw, 'base64');
  const isBase64 = decoded.length > 0 && decoded.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '');
  return { isBase64, bytes: isBase64 ? decoded.length : Buffer.from(raw, 'utf8').length };
}

// Session and OAuth-state tokens must never be interchangeable: the state token
// travels through the browser URL to Google, so it is public by design.
function keyFor(tokenType) {
  return crypto.createHmac('sha256', secretBytes()).update(`smartsearch-key:${tokenType}`).digest();
}

export function signToken(tokenType, claims, lifetimeSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ aud: cfg.ssoAud, iat: now, exp: now + lifetimeSeconds, ...claims, typ: tokenType });
  const signature = crypto
    .createHmac('sha256', keyFor(tokenType))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token, expectedType = TOKEN_TYPE_SESSION) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header, payload, sigBuf;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString());
    payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    sigBuf = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', keyFor(expectedType)).update(`${h}.${p}`).digest();
  if (expected.length !== sigBuf.length || !crypto.timingSafeEqual(expected, sigBuf)) return null;
  if (payload.typ !== expectedType) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return null;
  if (payload.nbf && now < payload.nbf) return null;
  if (cfg.ssoAud) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(cfg.ssoAud)) return null;
  }
  if (expectedType === TOKEN_TYPE_SESSION && !String(payload.sub || '').trim()) return null;
  return payload;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return { token: auth.slice(7), fromQuery: false };
  const queryToken = req.query.sso_token || req.query.token;
  if (queryToken) return { token: String(queryToken), fromQuery: true };
  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME]) return { token: cookies[COOKIE_NAME], fromQuery: false };
  return { token: null, fromQuery: false };
}

export function setSessionCookie(req, res, token, maxAge) {
  const secure = req.secure || cfg.cookieSecure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
  );
}

const googleLoginAvailable = () => !!(cfg.googleLoginClientId && cfg.googleLoginClientSecret);

const deniedHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>SmartSearch Auto · AWM</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  body { font-family: "Inter", -apple-system, "Segoe UI", system-ui, sans-serif; background: #f6f3ec; color: #2e2a24;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #eae4d8; border-radius: 14px; padding: 34px 38px; max-width: 420px;
          text-align: center; box-shadow: 0 1px 2px rgba(60,50,30,0.03); }
  .ico { width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 50%; background: #fdecea; color: #c2402f;
         display: grid; place-items: center; font-size: 22px; }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { font-size: 13px; color: #8f887c; line-height: 1.5; margin: 0 0 18px; }
  a.btn { display: inline-block; background: #24404a; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 10px; font-size: 13px; font-weight: 600; }
</style></head>
<body><div class="card"><div class="ico">🔒</div><h1>Sign in required</h1>
<p>This app is for Ascot Wealth Management staff.<br>
Sign in with your <strong>@ascotwm.com</strong> Google account.</p>
<a class="btn" href="/auth/google">Sign in with Google</a></div></body></html>`;

// Defence-in-depth against CSRF on cookie-authenticated writes. SameSite=Lax
// already blocks cross-site form POSTs; this also rejects requests whose Origin
// does not match the host, and requires a header the browser will not attach
// cross-origin without a passing preflight.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'Invalid Origin header' });
    }
    if (originHost !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }
  }

  if (req.headers['x-requested-with'] !== 'smartsearch-auto') {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }
  return next();
}

export async function ssoMiddleware(req, res, next) {
  if (cfg.iapEnabled && req.headers['x-goog-iap-jwt-assertion']) {
    try {
      const iap = await verifyIapAssertion(req.headers['x-goog-iap-jwt-assertion']);
      const email = String(iap?.email || '').toLowerCase();
      if (iap && email.endsWith(`@${cfg.allowedEmailDomain}`)) {
        req.user = { sub: email, via: 'iap' };
        return next();
      }
      if (iap) {
        return res
          .status(403)
          .type('html')
          .send(deniedHtml.replace('Sign in required', `Access is limited to @${cfg.allowedEmailDomain} accounts`));
      }
    } catch (err) {
      console.warn(`IAP assertion verification failed: ${err.message}`);
    }
  }

  const { token, fromQuery } = extractToken(req);
  const payload = token ? verifyToken(token, TOKEN_TYPE_SESSION) : null;

  if (!payload) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'SSO authentication required' });
    }
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
      if (googleLoginAvailable()) {
        return res.redirect(`/auth/google?next=${encodeURIComponent(req.originalUrl)}`);
      }
      if (cfg.ssoPortalUrl) {
        const returnUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const sep = cfg.ssoPortalUrl.includes('?') ? '&' : '?';
        return res.redirect(`${cfg.ssoPortalUrl}${sep}redirect_uri=${encodeURIComponent(returnUrl)}`);
      }
    }
    return res.status(401).type('html').send(deniedHtml);
  }

  req.user = payload;
  if (fromQuery) {
    const maxAge = payload.exp
      ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000))
      : 8 * 3600;
    setSessionCookie(req, res, token, maxAge);
    return res.redirect(req.path);
  }
  next();
}

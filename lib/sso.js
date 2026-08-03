import crypto from 'node:crypto';
import { cfg } from '../config.js';

const COOKIE_NAME = 'sso_token';

function candidateSecrets() {
  const secrets = [Buffer.from(cfg.ssoSecret, 'utf8')];
  try {
    const decoded = Buffer.from(cfg.ssoSecret, 'base64');
    if (decoded.length && decoded.toString('base64') === cfg.ssoSecret.replace(/\s/g, '')) {
      secrets.unshift(decoded);
    }
  } catch { /* not base64 — raw secret only */ }
  return secrets;
}

export function verifyToken(token) {
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
  const data = `${h}.${p}`;
  const valid = candidateSecrets().some((secret) => {
    const expected = crypto.createHmac('sha256', secret).update(data).digest();
    return expected.length === sigBuf.length && crypto.timingSafeEqual(expected, sigBuf);
  });
  if (!valid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return null;
  if (payload.nbf && now < payload.nbf) return null;
  if (cfg.ssoAud) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(cfg.ssoAud)) return null;
  }
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

const googleLoginAvailable = () => !!(cfg.googleOAuthClientId && cfg.googleOAuthClientSecret);

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

export function ssoMiddleware(req, res, next) {
  const { token, fromQuery } = extractToken(req);
  const payload = token ? verifyToken(token) : null;

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

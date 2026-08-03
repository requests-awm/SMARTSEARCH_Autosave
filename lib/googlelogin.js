import crypto from 'node:crypto';
import { cfg } from '../config.js';
import { verifyToken, setSessionCookie } from './sso.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signSessionJwt(claims, lifetimeSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ aud: cfg.ssoAud, iat: now, exp: now + lifetimeSeconds, ...claims });
  const signature = crypto
    .createHmac('sha256', Buffer.from(cfg.ssoSecret, 'base64'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function googleLoginEnabled() {
  return !!(cfg.googleLoginClientId && cfg.googleLoginClientSecret);
}

function origin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function deniedPage(message) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>SmartSearch Auto · AWM</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  body { font-family: "Inter", -apple-system, "Segoe UI", system-ui, sans-serif; background: #f6f3ec; color: #2e2a24;
         display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border: 1px solid #eae4d8; border-radius: 14px; padding: 34px 38px; max-width: 420px; text-align: center; }
  .ico { width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 50%; background: #fdecea; color: #c2402f; display: grid; place-items: center; font-size: 22px; }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { font-size: 13px; color: #8f887c; line-height: 1.5; margin: 0 0 18px; }
  a.btn { display: inline-block; background: #24404a; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 10px; font-size: 13px; font-weight: 600; }
</style></head>
<body><div class="card"><div class="ico">🔒</div><h1>Sign-in not permitted</h1>
<p>${message}</p><a class="btn" href="/auth/google">Try again</a></div></body></html>`;
}

export function registerGoogleLoginRoutes(app, wrap) {
  app.get('/auth/google', (req, res) => {
    if (!googleLoginEnabled()) return res.status(500).send('Google login is not configured');
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '/';
    const state = signSessionJwt({ purpose: 'oauth_state', returnTo: next }, 600);
    const params = new URLSearchParams({
      client_id: cfg.googleLoginClientId,
      redirect_uri: `${origin(req)}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      hd: cfg.allowedEmailDomain,
      prompt: 'select_account',
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get(
    '/auth/google/callback',
    wrap(async (req, res) => {
      const state = verifyToken(String(req.query.state || ''));
      if (!state || state.purpose !== 'oauth_state') {
        return res.status(403).type('html').send(deniedPage('Your sign-in attempt expired or was invalid. Please try again.'));
      }
      if (!req.query.code) {
        return res.status(403).type('html').send(deniedPage('Google did not complete the sign-in. Please try again.'));
      }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: cfg.googleLoginClientId,
          client_secret: cfg.googleLoginClientSecret,
          redirect_uri: `${origin(req)}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.id_token) {
        return res.status(403).type('html').send(deniedPage('Could not verify your Google account. Please try again.'));
      }
      const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
      const email = String(claims.email || '').toLowerCase();
      const domainOk =
        claims.email_verified === true &&
        (email.endsWith(`@${cfg.allowedEmailDomain}`) || claims.hd === cfg.allowedEmailDomain);
      if (!domainOk) {
        return res
          .status(403)
          .type('html')
          .send(deniedPage(`Access is limited to <strong>@${cfg.allowedEmailDomain}</strong> accounts. You signed in as ${email || 'an unknown account'}.`));
      }
      const session = signSessionJwt({ sub: email, name: claims.name || '' }, 12 * 3600);
      setSessionCookie(req, res, session, 12 * 3600);
      res.redirect(state.returnTo || '/');
    })
  );
}

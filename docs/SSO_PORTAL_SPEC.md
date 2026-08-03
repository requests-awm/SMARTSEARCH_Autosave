# SSO Portal Integration Spec — SmartSearch Auto

What the AWM SSO portal must implement so users land in SmartSearch Auto
signed-in, with no manual tokens.

## Flow

```
1. User visits SmartSearch Auto (no session cookie)
2. App 302-redirects to:  {SSO_PORTAL_URL}?redirect_uri=<app-url>
3. Portal checks its own login session (logs the user in if needed)
4. Portal validates redirect_uri against its app whitelist
5. Portal 302-redirects back to:  <redirect_uri>?sso_token=<JWT>
6. App verifies the JWT, sets an HttpOnly Secure cookie, strips the
   token from the URL. User is in for the token's lifetime.
```

The app side (steps 1, 2, 6) is already live. The portal owns steps 3–5.

## Token the portal must emit

**Format:** JWT, `alg: HS256`, `typ: JWT`.

**Signing key:** the shared secret is distributed as a base64 string
(`SSO_SHARED_SECRET`, same value the app holds). Sign with the
**base64-decoded bytes** as the HMAC key.

**Claims:**

| Claim | Required | Value |
|---|---|---|
| `aud` | yes | `clientsignup.ascotwm.com` (exact string; the app rejects anything else) |
| `exp` | yes | Unix seconds. Recommend now + 8h. The app rejects expired tokens with no leeway — keep portal clocks on NTP |
| `iat` | yes | Unix seconds, issue time |
| `sub` | yes | The user's AWM email — shows up in audit trails |
| `nbf` | optional | Honored if present |
| `name` | optional | Display name, ignored today, reserved for the UI |

## Redirect contract

- Return the user to **exactly** the `redirect_uri` received, appending
  `?sso_token=<jwt>` (use `&` if the URI already has a query string).
- **Whitelist `redirect_uri`** before redirecting — prefix-match against
  registered app origins (the Cloud Run URL of SmartSearch Auto, plus any
  future custom domain). Never redirect to unlisted hosts: an open
  redirect here would hand signed tokens to attacker-controlled pages.
- The portal must only issue tokens for users with a valid portal login
  session. Never issue on unauthenticated requests.

## Reference implementation (Node)

```js
import crypto from 'node:crypto';

const ALLOWED_APPS = [
  'https://smartsearch-auto-XXXXXXXX.run.app', // + future custom domains
];

function issueSsoToken(userEmail) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({
    sub: userEmail,
    aud: 'clientsignup.ascotwm.com',
    iat: now,
    exp: now + 8 * 3600,
  });
  const signature = crypto
    .createHmac('sha256', Buffer.from(process.env.SSO_SHARED_SECRET, 'base64'))
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// GET /sso/launch?redirect_uri=...
app.get('/sso/launch', requirePortalLogin, (req, res) => {
  const target = String(req.query.redirect_uri || '');
  if (!ALLOWED_APPS.some((origin) => target.startsWith(origin))) {
    return res.status(400).send('redirect_uri not whitelisted');
  }
  const sep = target.includes('?') ? '&' : '?';
  res.redirect(`${target}${sep}sso_token=${issueSsoToken(req.user.email)}`);
});
```

## App-side configuration

On SmartSearch Auto, set one env var and redeploy:

```
SSO_PORTAL_URL=https://<portal-host>/sso/launch
```

Unset = the app shows its static lock page instead of redirecting
(current behavior). API calls (`/api/*`) always get a 401 JSON rather
than a redirect, so the frontend and scripts fail cleanly.

## Security notes

- Tokens ride the URL exactly once, are exchanged for an HttpOnly
  SameSite=Lax cookie (Secure on HTTPS), and the URL is cleaned — they
  do not persist in the address bar. They do land in browser history
  once; the 8h expiry bounds that exposure.
- Rotating `SSO_SHARED_SECRET`: update portal and app together; all
  existing sessions and tokens die instantly (this is the kill switch).
- The app verifies signature (timing-safe), `alg === HS256` only,
  `aud`, `exp`, `nbf`. Anything else is rejected with the lock page.

import 'dotenv/config';
import crypto from 'node:crypto';

const secretB64 = (process.env.SSO_SHARED_SECRET || '').trim();
if (!secretB64) {
  console.error('SSO_SHARED_SECRET is not set in .env');
  process.exit(1);
}

const hours = Number(process.argv[2] || 8);
const now = Math.floor(Date.now() / 1000);
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

const header = b64url({ alg: 'HS256', typ: 'JWT' });
const payload = b64url({
  sub: process.env.USERNAME || 'local-user',
  aud: (process.env.SSO_AUD || '').trim(),
  iat: now,
  exp: now + hours * 3600,
});
const signature = crypto
  .createHmac('sha256', Buffer.from(secretB64, 'base64'))
  .update(`${header}.${payload}`)
  .digest('base64url');

const token = `${header}.${payload}.${signature}`;
const port = process.env.PORT || 3000;
console.log(`Token (valid ${hours}h):\n${token}\n`);
console.log(`Sign-in URL:\nhttp://localhost:${port}/?sso_token=${token}`);

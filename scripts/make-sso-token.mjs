import 'dotenv/config';
import { signToken, TOKEN_TYPE_SESSION } from '../lib/sso.js';

if (!(process.env.SSO_SHARED_SECRET || '').trim()) {
  console.error('SSO_SHARED_SECRET is not set in .env');
  process.exit(1);
}

const hours = Number(process.argv[2] || 8);

let token;
try {
  token = signToken(TOKEN_TYPE_SESSION, { sub: process.env.USERNAME || 'local-user' }, hours * 3600);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const port = process.env.PORT || 3000;
console.log(`Token (valid ${hours}h):\n${token}\n`);
console.log(`Sign-in URL:\nhttp://localhost:${port}/?sso_token=${token}`);

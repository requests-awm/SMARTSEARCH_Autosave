import crypto from 'node:crypto';
import { cfg } from '../config.js';

const JWK_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
let jwkCache = { keys: null, fetchedAt: 0 };

async function getKey(kid) {
  if (!jwkCache.keys || Date.now() - jwkCache.fetchedAt > 12 * 3600 * 1000) {
    const res = await fetch(JWK_URL);
    if (!res.ok) throw new Error(`IAP JWK fetch failed (${res.status})`);
    jwkCache = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
  }
  return jwkCache.keys.find((k) => k.kid === kid) || null;
}

export async function verifyIapAssertion(assertion) {
  const parts = String(assertion || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString());
    payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch {
    return null;
  }
  if (header.alg !== 'ES256') return null;
  const jwk = await getKey(header.kid);
  if (!jwk) return null;
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url')
  );
  if (!valid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== 'https://cloud.google.com/iap') return null;
  if (payload.exp && now >= payload.exp) return null;
  if (cfg.iapAudience && payload.aud !== cfg.iapAudience) return null;
  return payload;
}

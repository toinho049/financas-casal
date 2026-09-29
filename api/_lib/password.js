import crypto from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 32;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, KEYLEN, { N, r, p });
  return `s1$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export function verifyPassword(pw, stored) {
  try {
    const [v, s, h] = String(stored).split('$');
    if (v !== 's1') return false;
    const calc = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), KEYLEN, { N, r, p });
    const want = Buffer.from(h, 'base64url');
    return want.length === calc.length && crypto.timingSafeEqual(want, calc);
  } catch {
    return false;
  }
}

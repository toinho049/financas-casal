import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || '';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 dias

// USERS="mateus:senha1;esposa:senha2"
export function users() {
  return Object.fromEntries(
    (process.env.USERS || '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.includes(':'))
      .map((s) => {
        const i = s.indexOf(':');
        return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1)];
      })
  );
}

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

export function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

export function makeToken(user) {
  const payload = Buffer.from(`${user}|${Date.now() + MAX_AGE * 1000}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readUser(req) {
  if (!SECRET) return null;
  const token = req.cookies?.sess;
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  const [user, exp] = Buffer.from(payload, 'base64url').toString().split('|');
  if (Date.now() > Number(exp)) return null;
  if (!(user in users())) return null; // remover do USERS revoga o acesso
  return user;
}

export function setCookie(res, token, maxAge = MAX_AGE) {
  res.setHeader('Set-Cookie', `sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

import crypto from 'node:crypto';
import { q } from './db.js';

const SECRET = process.env.SESSION_SECRET || '';
export const MAX_AGE = 30 * 24 * 60 * 60; // 30 dias

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');

function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// O token carrega um pedaço do hash da senha: trocar a senha derruba sessões antigas.
const tag = (user) => user.pass_hash.slice(-12);

export function makeToken(user) {
  const payload = Buffer.from(`${user.id}|${Date.now() + MAX_AGE * 1000}|${tag(user)}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function setCookie(res, token, maxAge = MAX_AGE) {
  res.setHeader('Set-Cookie', `sess=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

export const SESSION_SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.pass_hash, u.account_id,
         a.name AS account_name, a.plan, a.subscription_status, a.subscription_plan, a.split_mode,
         (a.paid_until AT TIME ZONE 'America/Sao_Paulo')::date::text AS paid_until,
         (a.paid_until IS NOT NULL AND a.paid_until > now()) AS active,
         CASE WHEN a.paid_until IS NULL THEN NULL
              ELSE CEIL(EXTRACT(EPOCH FROM (a.paid_until - now())) / 86400)::int END AS days_left
  FROM users u JOIN accounts a ON a.id = u.account_id`;

export async function getSession(req) {
  if (!SECRET) return null;
  const token = req.cookies?.sess;
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  const [uid, exp, t] = Buffer.from(payload, 'base64url').toString().split('|');
  if (!Number(uid) || Date.now() > Number(exp)) return null;
  const [u] = await q(`${SESSION_SELECT} WHERE u.id = $1`, [Number(uid)]);
  if (!u || tag(u) !== t) return null;
  return u;
}

export function requireSecret(res) {
  if (!SECRET) {
    res.status(500).json({ error: 'Configure SESSION_SECRET nas variáveis de ambiente da Vercel.' });
    return false;
  }
  return true;
}

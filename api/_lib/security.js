import { q } from './db.js';

export const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'desconhecido';

// Conta tentativas recentes por chave (ex.: "login-email:ana@x.com", "login-ip:1.2.3.4")
export async function tooMany(limits, windowMin = 15) {
  for (const [key, max] of limits) {
    const [{ n }] = await q(
      `SELECT count(*)::int AS n FROM login_attempts WHERE key = $1 AND created_at > now() - make_interval(mins => $2)`,
      [key, windowMin]
    );
    if (n >= max) return true;
  }
  return false;
}

export async function record(keys) {
  for (const key of keys) await q(`INSERT INTO login_attempts (key) VALUES ($1)`, [key]);
  if (Math.random() < 0.05) await q(`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`);
}

export const clear = (key) => q(`DELETE FROM login_attempts WHERE key = $1`, [key]);

export function isAdmin(u) {
  const list = (process.env.ADMIN_EMAILS || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !!u && list.includes(String(u.email).toLowerCase());
}

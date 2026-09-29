import { users, makeToken, readUser, setCookie, safeEq } from './_lib/auth.js';

export default function handler(req, res) {
  const U = users();
  const names = Object.keys(U);

  if (req.method === 'GET') {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: 'Não autenticado' });
    return res.json({ user, users: names });
  }

  if (req.method === 'POST') {
    if (!process.env.SESSION_SECRET || !names.length) {
      return res.status(500).json({ error: 'Configure USERS e SESSION_SECRET nas variáveis de ambiente da Vercel.' });
    }
    const { user = '', pass = '' } = req.body || {};
    const u = String(user).trim().toLowerCase();
    if (!U[u] || !safeEq(U[u], pass)) {
      return res.status(400).json({ error: 'Usuário ou senha inválidos' });
    }
    setCookie(res, makeToken(u));
    return res.json({ user: u, users: names });
  }

  if (req.method === 'DELETE') {
    setCookie(res, '', 0);
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Método não permitido' });
}

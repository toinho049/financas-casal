import { q } from './_lib/db.js';
import { getSession, makeToken, setCookie, requireSecret, SESSION_SELECT } from './_lib/auth.js';
import { hashPassword, verifyPassword } from './_lib/password.js';
import { publicPlans } from './_lib/billing.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 5;

async function mePayload(u) {
  const members = await q(`SELECT id, name, email, role FROM users WHERE account_id = $1 ORDER BY id`, [u.account_id]);
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role },
    account: { name: u.account_name, plan: u.plan, paid_until: u.paid_until, active: u.active },
    members,
    plans: publicPlans(),
  };
}

async function loadUser(where, params) {
  const [u] = await q(`${SESSION_SELECT} WHERE ${where}`, params);
  return u;
}

export default async function handler(req, res) {
  const action = req.query.action || '';
  const body = req.body || {};
  try {
    // Sessão atual
    if (req.method === 'GET') {
      const u = await getSession(req);
      if (!u) return res.status(401).json({ error: 'Não autenticado' });
      return res.json(await mePayload(u));
    }

    if (req.method === 'DELETE' || action === 'logout') {
      setCookie(res, '', 0);
      return res.json({ ok: true });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
    if (!requireSecret(res)) return;

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      const u = email && (await loadUser('u.email = $1', [email]));
      // mesmo custo de verificação exista ou não o usuário
      const ok = verifyPassword(body.password || '', u ? u.pass_hash : 's1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      if (!u || !ok) return res.status(400).json({ error: 'E-mail ou senha inválidos' });
      setCookie(res, makeToken(u));
      return res.json(await mePayload(u));
    }

    if (action === 'signup') {
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (name.length < 2) return res.status(400).json({ error: 'Informe seu nome' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
      if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres' });
      try {
        await q(
          `WITH a AS (INSERT INTO accounts (name) VALUES ($1) RETURNING id)
           INSERT INTO users (account_id, email, name, pass_hash, role)
           SELECT id, $2, $3, $4, 'owner' FROM a`,
          [String(body.account_name || `Casa de ${name.split(' ')[0]}`).slice(0, 80), email, name.slice(0, 60), hashPassword(password)]
        );
      } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Este e-mail já tem cadastro. Use "Entrar".' });
        throw e;
      }
      const u = await loadUser('u.email = $1', [email]);
      setCookie(res, makeToken(u));
      return res.status(201).json(await mePayload(u));
    }

    // Daqui para baixo precisa estar logado
    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });

    if (action === 'password') {
      const nova = String(body.new_password || '');
      if (!verifyPassword(body.password || '', me.pass_hash)) return res.status(400).json({ error: 'Senha atual incorreta' });
      if (nova.length < 8) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres' });
      await q(`UPDATE users SET pass_hash = $1 WHERE id = $2`, [hashPassword(nova), me.id]);
      const u = await loadUser('u.id = $1', [me.id]);
      setCookie(res, makeToken(u));
      return res.json({ ok: true });
    }

    if (action === 'member') {
      if (me.role !== 'owner') return res.status(403).json({ error: 'Só o titular da conta pode gerenciar pessoas' });
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (name.length < 2) return res.status(400).json({ error: 'Informe o nome' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
      if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres' });
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM users WHERE account_id = $1`, [me.account_id]);
      if (n >= MAX_MEMBERS) return res.status(400).json({ error: `Limite de ${MAX_MEMBERS} pessoas por conta` });
      try {
        await q(`INSERT INTO users (account_id, email, name, pass_hash, role) VALUES ($1, $2, $3, $4, 'member')`,
          [me.account_id, email, name.slice(0, 60), hashPassword(password)]);
      } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Este e-mail já está em uso' });
        throw e;
      }
      return res.status(201).json(await mePayload(me));
    }

    if (action === 'remove-member') {
      if (me.role !== 'owner') return res.status(403).json({ error: 'Só o titular da conta pode gerenciar pessoas' });
      await q(`DELETE FROM users WHERE id = $1 AND account_id = $2 AND role <> 'owner'`, [Number(body.id), me.account_id]);
      return res.json(await mePayload(me));
    }

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

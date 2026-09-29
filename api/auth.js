import crypto from 'node:crypto';
import { q } from './_lib/db.js';
import { getSession, makeToken, setCookie, requireSecret, SESSION_SELECT } from './_lib/auth.js';
import { hashPassword, verifyPassword } from './_lib/password.js';
import { publicPlans, baseUrl } from './_lib/billing.js';
import { clientIp, tooMany, record, clear, isAdmin } from './_lib/security.js';
import { sendMail, resetEmail, mailEnabled } from './_lib/mail.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 5;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function mePayload(u) {
  const members = await q(`SELECT id, name, email, role FROM users WHERE account_id = $1 ORDER BY id`, [u.account_id]);
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, admin: isAdmin(u) },
    account: { name: u.account_name, plan: u.plan, paid_until: u.paid_until, active: u.active },
    members,
    plans: publicPlans(),
    mail: mailEnabled(),
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
      const ip = clientIp(req);
      const kEmail = `login-email:${email}`, kIp = `login-ip:${ip}`;
      if (await tooMany([[kEmail, 8], [kIp, 30]])) {
        return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos ou use "Esqueci minha senha".' });
      }
      const u = email && (await loadUser('u.email = $1', [email]));
      // mesmo custo de verificação exista ou não o usuário
      const ok = verifyPassword(body.password || '', u ? u.pass_hash : 's1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      if (!u || !ok) {
        await record([kEmail, kIp]);
        return res.status(400).json({ error: 'E-mail ou senha inválidos' });
      }
      await clear(kEmail);
      setCookie(res, makeToken(u));
      return res.json(await mePayload(u));
    }

    // Pede o link de redefinição. Responde igual exista ou não o e-mail.
    if (action === 'forgot') {
      if (!mailEnabled()) return res.status(400).json({ error: 'Redefinição por e-mail indisponível. Peça para o titular da conta redefinir sua senha.' });
      const email = String(body.email || '').trim().toLowerCase();
      const done = { ok: true, message: 'Se esse e-mail tiver cadastro, enviamos um link para criar uma nova senha. Confira também a caixa de spam.' };
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Informe o e-mail do cadastro' });
      const k = `forgot:${email}`, kIp = `forgot-ip:${clientIp(req)}`;
      if (await tooMany([[k, 3], [kIp, 10]], 60)) return res.json(done);
      await record([k, kIp]);
      const [u] = await q(`SELECT id, name FROM users WHERE email = $1`, [email]);
      if (u) {
        const token = crypto.randomBytes(32).toString('base64url');
        await q(`UPDATE password_resets SET used = true WHERE user_id = $1 AND used = false`, [u.id]);
        await q(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [sha256(token), u.id]);
        await sendMail({ to: email, subject: 'Redefinir sua senha — Finanças do Casal', html: resetEmail(u.name, `${baseUrl(req)}/?reset=${token}`) });
      }
      return res.json(done);
    }

    // Cria a nova senha a partir do link
    if (action === 'reset') {
      const password = String(body.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres' });
      const rows = await q(
        `UPDATE password_resets SET used = true
         WHERE token_hash = $1 AND used = false AND expires_at > now()
         RETURNING user_id`,
        [sha256(String(body.token || ''))]
      );
      if (!rows.length) return res.status(400).json({ error: 'Link inválido ou expirado. Peça um novo em "Esqueci minha senha".' });
      await q(`UPDATE users SET pass_hash = $1 WHERE id = $2`, [hashPassword(password), rows[0].user_id]);
      const u = await loadUser('u.id = $1', [rows[0].user_id]);
      await clear(`login-email:${u.email}`);
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

    if (action === 'member-password') {
      if (me.role !== 'owner') return res.status(403).json({ error: 'Só o titular da conta pode redefinir senhas' });
      const password = String(body.password || '');
      if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres' });
      const rows = await q(`UPDATE users SET pass_hash = $1 WHERE id = $2 AND account_id = $3 AND id <> $4 RETURNING email`,
        [hashPassword(password), Number(body.id), me.account_id, me.id]);
      if (!rows.length) return res.status(404).json({ error: 'Pessoa não encontrada' });
      await clear(`login-email:${rows[0].email}`);
      return res.json({ ok: true });
    }

    // Trocar o próprio nome e e-mail de login
    if (action === 'profile') {
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      if (name.length < 2) return res.status(400).json({ error: 'Informe o nome' });
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
      try {
        await q(`UPDATE users SET name = $1, email = $2 WHERE id = $3`, [name.slice(0, 60), email, me.id]);
        if (name.slice(0, 60) !== me.name) {
          await q(`UPDATE transactions SET person = $1 WHERE account_id = $2 AND person = $3`, [name.slice(0, 60), me.account_id, me.name]);
        }
      } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Este e-mail já está em uso' });
        throw e;
      }
      return res.json(await mePayload(await loadUser('u.id = $1', [me.id])));
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

import { q, getSetting, setSetting } from './_lib/db.js';
import { getSession } from './_lib/auth.js';
import { isAdmin } from './_lib/security.js';

export default async function handler(req, res) {
  try {
    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });
    if (!isAdmin(me)) return res.status(403).json({ error: 'Acesso restrito' });
    const action = req.query.action || 'overview';

    if (req.method === 'GET' && action === 'overview') {
      const [stats] = await q(`
        SELECT count(*)::int AS contas,
               count(*) FILTER (WHERE paid_until > now() AND plan IS DISTINCT FROM 'vitalicio' AND plan IS DISTINCT FROM 'teste')::int AS pagantes,
               count(*) FILTER (WHERE paid_until > now() AND plan = 'teste')::int AS em_teste,
               count(*) FILTER (WHERE paid_until IS NULL)::int AS sem_pagamento,
               count(*) FILTER (WHERE paid_until IS NOT NULL AND paid_until <= now())::int AS vencidas,
               count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS novas_30d
        FROM accounts`);
      const [rev] = await q(`
        SELECT COALESCE(sum(amount) FILTER (WHERE date_trunc('month', updated_at AT TIME ZONE 'America/Sao_Paulo')
                                              = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')), 0)::float8 AS mes,
               COALESCE(sum(amount), 0)::float8 AS total,
               count(*)::int AS pagamentos
        FROM payments WHERE credited`);
      const accounts = await q(`
        SELECT a.id, a.name, a.plan, a.campaign, a.subscription_status,
               (a.paid_until AT TIME ZONE 'America/Sao_Paulo')::date::text AS paid_until,
               (a.paid_until IS NOT NULL AND a.paid_until > now()) AS active,
               (a.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS created,
               (SELECT email FROM users WHERE account_id = a.id AND role = 'owner' ORDER BY id LIMIT 1) AS owner_email,
               (SELECT count(*)::int FROM users WHERE account_id = a.id) AS members,
               (SELECT COALESCE(sum(amount), 0)::float8 FROM payments WHERE account_id = a.id AND credited) AS paid_total
        FROM accounts a ORDER BY a.created_at DESC LIMIT 1000`);
      const payments = await q(`
        SELECT p.id, p.account_id, a.name AS account_name, p.plan, p.amount::float8 AS amount, p.status, p.credited,
               to_char(p.updated_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') AS quando
        FROM payments p LEFT JOIN accounts a ON a.id = p.account_id
        ORDER BY p.updated_at DESC LIMIT 50`);
      const campaigns = await q(`SELECT code, days, active, uses FROM campaigns ORDER BY created_at DESC`);
      const trial_days = Math.max(0, Math.trunc(Number(await getSetting('trial_days', 0)) || 0));
      return res.json({ stats, revenue: rev, accounts, payments, campaigns, trial_days });
    }

    // Teste grátis padrão para qualquer cadastro novo (0 = sem teste)
    if (req.method === 'POST' && action === 'trial') {
      const days = Math.trunc(Number(req.body?.days));
      if (!(days >= 0 && days <= 365)) return res.status(400).json({ error: 'Informe de 0 a 365 dias' });
      await setSetting('trial_days', days);
      return res.json({ trial_days: days });
    }

    // Links de campanha: quem se cadastra pelo link ganha N dias grátis
    if (req.method === 'POST' && action === 'campaign') {
      const code = String(req.body?.code || '').trim().toUpperCase();
      const days = Math.trunc(Number(req.body?.days));
      if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return res.status(400).json({ error: 'Código com 3 a 40 letras, números, - ou _' });
      if (!(days >= 1 && days <= 3650)) return res.status(400).json({ error: 'Informe de 1 a 3650 dias' });
      try {
        await q(`INSERT INTO campaigns (code, days) VALUES ($1, $2)`, [code, days]);
      } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Já existe uma campanha com esse código' });
        throw e;
      }
      return res.status(201).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'campaign-toggle') {
      const rows = await q(`UPDATE campaigns SET active = NOT active WHERE code = $1 RETURNING active`, [String(req.body?.code || '')]);
      if (!rows.length) return res.status(404).json({ error: 'Campanha não encontrada' });
      return res.json(rows[0]);
    }

    // Dar (ou tirar) dias de acesso manualmente: cortesia, Pix que não caiu, etc.
    if (req.method === 'POST' && action === 'extend') {
      const days = Math.trunc(Number(req.body?.days));
      if (!days || days < -3650 || days > 3650) return res.status(400).json({ error: 'Quantidade de dias inválida' });
      const rows = await q(
        `UPDATE accounts SET paid_until = GREATEST(COALESCE(paid_until, now()), now()) + make_interval(days => $1)
         WHERE id = $2 AND plan IS DISTINCT FROM 'vitalicio'
         RETURNING (paid_until AT TIME ZONE 'America/Sao_Paulo')::date::text AS paid_until`,
        [days, Number(req.body?.account_id)]
      );
      if (!rows.length) return res.status(404).json({ error: 'Conta não encontrada (ou é vitalícia)' });
      return res.json(rows[0]);
    }

    // Pessoas de uma conta
    if (req.method === 'GET' && action === 'members') {
      const rows = await q(
        `SELECT id, name, email, role, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS created
         FROM users WHERE account_id = $1 ORDER BY role = 'owner' DESC, id`,
        [Number(req.query.account_id)]
      );
      return res.json(rows);
    }

    // Remove uma pessoa (o titular só sai excluindo a conta inteira)
    if (req.method === 'POST' && action === 'remove-user') {
      const rows = await q(
        `DELETE FROM users WHERE id = $1 AND role <> 'owner' AND id <> $2 RETURNING id`,
        [Number(req.body?.user_id), me.id]
      );
      if (!rows.length) return res.status(400).json({ error: 'Não é possível remover: é o titular da conta (exclua a conta inteira) ou é você.' });
      return res.json({ ok: true });
    }

    // Exclui a conta com todos os dados. Pagamentos ficam no histórico (sem vínculo).
    // Tudo num único comando: ou apaga tudo, ou nada.
    if (req.method === 'POST' && action === 'delete-account') {
      const rows = await q(
        `WITH a AS (
           SELECT id FROM accounts WHERE id = $1 AND plan IS DISTINCT FROM 'vitalicio' AND id <> $2
         ),
         t AS (DELETE FROM transactions WHERE account_id IN (SELECT id FROM a)),
         b AS (DELETE FROM bills WHERE account_id IN (SELECT id FROM a)),
         i AS (DELETE FROM investments WHERE account_id IN (SELECT id FROM a))
         DELETE FROM accounts WHERE id IN (SELECT id FROM a) RETURNING id`,
        [Number(req.body?.account_id), me.account_id]
      );
      if (!rows.length) return res.status(400).json({ error: 'Não é possível excluir esta conta (vitalícia ou a sua).' });
      return res.json({ ok: true });
    }

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

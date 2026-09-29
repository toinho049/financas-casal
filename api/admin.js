import { q } from './_lib/db.js';
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
               count(*) FILTER (WHERE paid_until > now() AND plan IS DISTINCT FROM 'vitalicio')::int AS pagantes,
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
        SELECT a.id, a.name, a.plan,
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
      return res.json({ stats, revenue: rev, accounts, payments });
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

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

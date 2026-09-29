import { q } from './_lib/db.js';
import { readUser } from './_lib/auth.js';

const R = {
  transactions: {
    fields: ['type', 'description', 'amount', 'category', 'date', 'person'],
    select: `id, type, description, amount::float8 AS amount, category, date::text AS date, person, bill_id`,
    order: 'date DESC, id DESC',
  },
  bills: {
    fields: ['description', 'amount', 'due_date', 'category', 'recurring', 'paid', 'paid_at'],
    select: `id, description, amount::float8 AS amount, due_date::text AS due_date, category, recurring, paid, paid_at::text AS paid_at`,
    order: 'paid ASC, due_date ASC, id',
  },
  investments: {
    fields: ['name', 'kind', 'invested', 'current_value', 'date', 'notes'],
    select: `id, name, kind, invested::float8 AS invested, current_value::float8 AS current_value, date::text AS date, notes, updated_at::text AS updated_at`,
    order: 'name, id',
  },
};

const clean = (v) => (v === '' || v === undefined ? null : v);

export default async function handler(req, res) {
  const user = readUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const table = req.query.r;
  const r = R[table];
  if (!r) return res.status(400).json({ error: 'Recurso inválido' });
  const id = req.query.id ? Number(req.query.id) : null;
  const body = req.body || {};

  try {
    if (req.method === 'GET') {
      return res.json(await q(`SELECT ${r.select} FROM ${table} ORDER BY ${r.order}`));
    }

    if (req.method === 'POST' && table === 'bills' && req.query.action === 'pay') {
      return res.json(await payBill(id, body, user));
    }

    const keys = r.fields.filter((k) => k in body);

    if (req.method === 'POST') {
      if (!keys.length) return res.status(400).json({ error: 'Nada para salvar' });
      const rows = await q(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING ${r.select}`,
        keys.map((k) => clean(body[k]))
      );
      return res.status(201).json(rows[0]);
    }

    if (!id) return res.status(400).json({ error: 'id obrigatório' });

    if (req.method === 'PUT') {
      if (!keys.length) return res.status(400).json({ error: 'Nada para salvar' });
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const extra = table === 'investments' ? ', updated_at = now()' : '';
      const rows = await q(
        `UPDATE ${table} SET ${set}${extra} WHERE id = $${keys.length + 1} RETURNING ${r.select}`,
        [...keys.map((k) => clean(body[k])), id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      return res.json(rows[0]);
    }

    if (req.method === 'DELETE') {
      await q(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return res.json({ ok: true });
    }

    res.status(405).json({ error: 'Método não permitido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

// Marca a conta como paga, lança a saída e, se for recorrente, cria a do mês seguinte
async function payBill(id, { date, person }, user) {
  const [b] = await q(
    `SELECT id, description, amount, category, recurring, paid, due_date::text AS due_date FROM bills WHERE id = $1`,
    [id]
  );
  if (!b) throw new Error('Conta não encontrada');
  if (b.paid) return { ok: true };
  const d = date || new Date().toISOString().slice(0, 10);

  await q(`UPDATE bills SET paid = true, paid_at = $2 WHERE id = $1`, [id, d]);
  await q(
    `INSERT INTO transactions (type, description, amount, category, date, person, bill_id)
     VALUES ('saida', $1, $2, $3, $4, $5, $6)`,
    [b.description, b.amount, b.category, d, person || user, id]
  );
  if (b.recurring) {
    await q(
      `INSERT INTO bills (description, amount, category, recurring, due_date)
       VALUES ($1, $2, $3, true, ($4::date + interval '1 month')::date)`,
      [b.description, b.amount, b.category, b.due_date]
    );
  }
  return { ok: true };
}

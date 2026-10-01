import crypto from 'node:crypto';
import { q } from './_lib/db.js';
import { getSession } from './_lib/auth.js';

const R = {
  transactions: {
    fields: ['type', 'description', 'amount', 'category', 'date', 'person', 'method', 'card_id'],
    select: `id, type, description, amount::float8 AS amount, category, date::text AS date, person, method, card_id, bill_id,
             installment_group, installment_no, installment_total`,
    order: 'date DESC, id DESC',
  },
  cards: {
    fields: ['name', 'closing_day', 'due_day', 'credit_limit'],
    select: `id, name, closing_day, due_day, credit_limit::float8 AS credit_limit`,
    order: 'lower(name), id',
  },
  card_paid: {
    fields: [],
    select: `card_id, month`,
    order: 'month',
  },
  goals: {
    fields: ['name', 'target', 'deadline'],
    select: `id, name, target::float8 AS target, saved::float8 AS saved, deadline::text AS deadline`,
    order: 'deadline NULLS LAST, id',
  },
  budgets: {
    fields: ['category', 'amount'],
    select: `id, category, amount::float8 AS amount`,
    order: 'lower(category)',
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

// Formas de pagamento aceitas (qualquer outro valor vira "não informado")
const METHODS = ['Pix', 'Cartão de crédito', 'Cartão de débito', 'Dinheiro', 'Boleto'];
const method = (v) => (METHODS.includes(v) ? v : null);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const day = (v) => { const n = Math.trunc(Number(v)); return n >= 1 && n <= 31 ? n : null; };

// Cartão informado no lançamento precisa ser desta conta
async function ownCard(v, acc) {
  const id = Math.trunc(Number(v));
  if (!id) return null;
  const [c] = await q(`SELECT id FROM cards WHERE id = $1 AND account_id = $2`, [id, acc]);
  return c ? c.id : null;
}

export default async function handler(req, res) {
  try {
    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });
    if (!me.active) return res.status(402).json({ error: 'Acesso vencido', code: 'inactive' });
    const acc = me.account_id;

    const table = req.query.r;
    const r = R[table];
    if (!r) return res.status(400).json({ error: 'Recurso inválido' });
    const id = req.query.id ? Number(req.query.id) : null;
    const body = req.body || {};

    if (req.method === 'GET') {
      return res.json(await q(`SELECT ${r.select} FROM ${table} WHERE account_id = $1 ORDER BY ${r.order}`, [acc]));
    }

    if (req.method === 'POST' && table === 'bills' && req.query.action === 'pay') {
      return res.json(await payBill(id, body, me));
    }

    if ('method' in body) body.method = method(body.method);
    if (table === 'transactions' && 'card_id' in body) body.card_id = await ownCard(body.card_id, acc);
    if (table === 'card_paid' && req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

    // Cartões: validação
    if (table === 'cards' && (req.method === 'POST' || req.method === 'PUT') && !req.query.action) {
      body.name = String(body.name || '').trim().slice(0, 40);
      if (!body.name) throw bad('Informe o nome do cartão');
      body.closing_day = day(body.closing_day); body.due_day = day(body.due_day);
      if (!body.closing_day || !body.due_day) throw bad('Informe os dias de fechamento e de vencimento (1 a 31)');
      if (body.credit_limit != null && body.credit_limit !== '' && !(Number(body.credit_limit) >= 0)) throw bad('Limite inválido');
    }
    // Fatura paga / não paga
    if (table === 'cards' && req.method === 'POST' && req.query.action === 'invoice') {
      const card = await ownCard(body.card_id, acc), month = String(body.month || '');
      if (!card || !/^\d{4}-\d{2}$/.test(month)) throw bad('Fatura inválida');
      if (body.paid) await q(`INSERT INTO card_paid (account_id, card_id, month) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [acc, card, month]);
      else await q(`DELETE FROM card_paid WHERE card_id = $1 AND month = $2 AND account_id = $3`, [card, month, acc]);
      return res.json({ ok: true });
    }
    // Metas: validação e "guardar / retirar"
    if (table === 'goals' && (req.method === 'POST' || req.method === 'PUT') && !req.query.action) {
      body.name = String(body.name || '').trim().slice(0, 60);
      if (!body.name) throw bad('Dê um nome para a meta');
      if (!(Number(body.target) > 0)) throw bad('Informe quanto vocês querem juntar');
      if (body.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.deadline))) body.deadline = null;
    }
    if (table === 'goals' && req.method === 'POST' && req.query.action === 'deposit') {
      const v = Number(body.amount);
      if (!v || !isFinite(v) || Math.abs(v) > 1e9) throw bad('Valor inválido');
      const rows = await q(
        `UPDATE goals SET saved = GREATEST(0, saved + $1) WHERE id = $2 AND account_id = $3 RETURNING ${R.goals.select}`,
        [Math.round(v * 100) / 100, id, acc]
      );
      if (!rows.length) return res.status(404).json({ error: 'Meta não encontrada' });
      return res.json(rows[0]);
    }
    const keys = r.fields.filter((k) => k in body);

    if (req.method === 'POST' && table === 'transactions' && req.query.action === 'import') {
      return res.json(await importRows(body.rows, me));
    }

    // Compra parcelada: gera uma saída por mês
    if (req.method === 'POST' && table === 'transactions' && Number(body.installments) > 1) {
      return res.status(201).json(await createInstallments(body, acc));
    }

    // Orçamento: um limite por categoria (salvar de novo atualiza)
    if (req.method === 'POST' && table === 'budgets') {
      const cat = String(body.category || '').trim().slice(0, 60);
      const amount = Number(body.amount);
      if (!cat) return res.status(400).json({ error: 'Informe a categoria' });
      if (!(amount > 0)) return res.status(400).json({ error: 'Informe um limite maior que zero' });
      const rows = await q(
        `INSERT INTO budgets (account_id, category, amount) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, lower(category)) DO UPDATE SET amount = EXCLUDED.amount
         RETURNING ${r.select}`,
        [acc, cat, amount]
      );
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'POST') {
      if (!keys.length) return res.status(400).json({ error: 'Nada para salvar' });
      const cols = [...keys, 'account_id'];
      const rows = await q(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING ${r.select}`,
        [...keys.map((k) => clean(body[k])), acc]
      );
      return res.status(201).json(rows[0]);
    }

    if (!id) return res.status(400).json({ error: 'id obrigatório' });

    if (req.method === 'PUT') {
      if (!keys.length) return res.status(400).json({ error: 'Nada para salvar' });
      const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const extra = table === 'investments' ? ', updated_at = now()' : '';
      const n = keys.length;
      const rows = await q(
        `UPDATE ${table} SET ${set}${extra} WHERE id = $${n + 1} AND account_id = $${n + 2} RETURNING ${r.select}`,
        [...keys.map((k) => clean(body[k])), id, acc]
      );
      if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
      return res.json(rows[0]);
    }

    if (req.method === 'DELETE') {
      // Parcelas: ?scope=future apaga esta e as seguintes do mesmo parcelamento
      if (table === 'transactions' && req.query.scope === 'future') {
        const rows = await q(
          `DELETE FROM transactions t USING transactions x
           WHERE x.id = $1 AND x.account_id = $2 AND x.installment_group IS NOT NULL
             AND t.account_id = x.account_id AND t.installment_group = x.installment_group
             AND t.installment_no >= x.installment_no
           RETURNING t.id`,
          [id, acc]
        );
        if (rows.length) return res.json({ ok: true, deleted: rows.length });
      }
      if (table === 'cards') await q(`UPDATE transactions SET card_id = NULL WHERE card_id = $1 AND account_id = $2`, [id, acc]);
      await q(`DELETE FROM ${table} WHERE id = $1 AND account_id = $2`, [id, acc]);
      return res.json({ ok: true, deleted: 1 });
    }

    res.status(405).json({ error: 'Método não permitido' });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    if (e.code === '23505') return res.status(400).json({ error: 'Já existe um limite para essa categoria' });
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

// Divide o total em N parcelas mensais (centavos que sobram vão na 1ª)
async function createInstallments(body, acc) {
  const n = Math.trunc(Number(body.installments));
  const total = Number(body.amount);
  if (!(n >= 2 && n <= 48)) throw Object.assign(new Error('Parcelas: de 2 a 48'), { status: 400 });
  if (!(total > 0)) throw Object.assign(new Error('Informe o valor total'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) throw Object.assign(new Error('Informe a data da 1ª parcela'), { status: 400 });
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n), first = cents - base * (n - 1);
  const group = crypto.randomUUID();
  const desc = String(body.description || '').trim().slice(0, 120) || 'Compra parcelada';
  const values = [], params = [];
  for (let i = 0; i < n; i++) {
    const p = params.length;
    values.push(`('saida', $${p + 1}, $${p + 2}, $${p + 3}, ($${p + 4}::date + make_interval(months => ${i}))::date, $${p + 5}, $${p + 6}, $${p + 7}, ${i + 1}, ${n}, $${p + 8}, $${p + 9})`);
    params.push(`${desc} (${i + 1}/${n})`, (i === 0 ? first : base) / 100, clean(body.category), body.date, clean(body.person), acc, group, method(body.method) || 'Cartão de crédito', body.card_id || null);
  }
  return q(
    `INSERT INTO transactions (type, description, amount, category, date, person, account_id, installment_group, installment_no, installment_total, method, card_id)
     VALUES ${values.join(',')} RETURNING ${R.transactions.select}`,
    params
  );
}

// Importa lançamentos de extrato; linhas repetidas (mesma chave) são ignoradas
async function importRows(rows, me) {
  if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error('Nenhuma linha para importar'), { status: 400 });
  if (rows.length > 2000) throw Object.assign(new Error('Máximo de 2000 linhas por vez'), { status: 400 });
  let inserted = 0;
  for (let s = 0; s < rows.length; s += 200) {
    const chunk = rows.slice(s, s + 200), values = [], params = [];
    for (const r of chunk) {
      const amount = Math.abs(Number(r.amount));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) || !(amount > 0) || !['entrada', 'saida'].includes(r.type)) continue;
      const p = params.length;
      values.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}::date, $${p + 6}, $${p + 7}, $${p + 8})`);
      params.push(r.type, String(r.description || 'Sem descrição').trim().slice(0, 120), amount, clean(r.category), r.date, me.name, me.account_id,
        String(r.key || `${r.date}|${r.type}|${amount.toFixed(2)}|${r.description}`).slice(0, 200));
    }
    if (!values.length) continue;
    const ins = await q(
      `INSERT INTO transactions (type, description, amount, category, date, person, account_id, import_key)
       VALUES ${values.join(',')}
       ON CONFLICT (account_id, import_key) WHERE import_key IS NOT NULL DO NOTHING
       RETURNING id`,
      params
    );
    inserted += ins.length;
  }
  return { inserted, skipped: rows.length - inserted };
}

// Marca a conta como paga, lança a saída e, se for recorrente, cria a do mês seguinte
async function payBill(id, { date, person, method: how }, me) {
  const acc = me.account_id;
  const [b] = await q(
    `SELECT id, description, amount, category, recurring, paid, due_date::text AS due_date
     FROM bills WHERE id = $1 AND account_id = $2`,
    [id, acc]
  );
  if (!b) throw new Error('Conta não encontrada');
  if (b.paid) return { ok: true };
  const d = date || new Date().toISOString().slice(0, 10);

  await q(`UPDATE bills SET paid = true, paid_at = $2 WHERE id = $1 AND account_id = $3`, [id, d, acc]);
  await q(
    `INSERT INTO transactions (type, description, amount, category, date, person, bill_id, account_id, method)
     VALUES ('saida', $1, $2, $3, $4, $5, $6, $7, $8)`,
    [b.description, b.amount, b.category, d, person || me.name, id, acc, method(how)]
  );
  if (b.recurring) {
    await q(
      `INSERT INTO bills (description, amount, category, recurring, due_date, account_id)
       VALUES ($1, $2, $3, true, ($4::date + interval '1 month')::date, $5)`,
      [b.description, b.amount, b.category, b.due_date, acc]
    );
  }
  return { ok: true };
}

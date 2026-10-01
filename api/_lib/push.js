import webpush from 'web-push';
import { q, getSetting } from './db.js';

// Chaves VAPID geradas uma vez e guardadas no banco: nada para configurar na Vercel.
let cached = null;
export async function vapidKeys() {
  if (cached) return cached;
  let keys = await getSetting('vapid');
  if (!keys?.publicKey || !keys?.privateKey) {
    const fresh = webpush.generateVAPIDKeys();
    // Só grava se ninguém gravou antes (duas funções podem subir juntas)
    await q(`INSERT INTO settings (key, value) VALUES ('vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(fresh)]);
    keys = await getSetting('vapid');
  }
  cached = keys;
  return keys;
}

// Envia para uma inscrição; apaga inscrições que o navegador já cancelou.
export async function sendPush(sub, payload, subject) {
  const keys = await vapidKeys();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 60 * 60 }
    );
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await q(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
      return false;
    }
    throw e;
  }
}

const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const pad = (n) => String(n).padStart(2, '0');
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();          // dias no mês (m = 1..12)
const ymd = (y, m, d) => { while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${pad(m)}-${pad(Math.min(d, dim(y, m)))}`; };

// Fatura de um cartão que VENCE no mês (y, m): período de compras e data de vencimento
export function invoiceRange(card, y, m) {
  const cm = card.due_day > card.closing_day ? m : m - 1;               // mês em que a fatura fecha
  return { from: ymd(y, cm - 1, card.closing_day), to: ymd(y, cm, card.closing_day), due: ymd(y, m, card.due_day) };
}

// Monta o aviso do dia de uma conta: contas vencidas, vencendo hoje/amanhã e acesso acabando.
export async function dailyDigest(accountId) {
  const [acc] = await q(
    `SELECT plan, CEIL(EXTRACT(EPOCH FROM (paid_until - now())) / 86400)::int AS days_left
     FROM accounts WHERE id = $1`,
    [accountId]
  );
  if (!acc) return null;
  const [b] = await q(
    `WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d)
     SELECT
       count(*) FILTER (WHERE due_date < hoje.d)::int AS vencidas,
       COALESCE(sum(amount) FILTER (WHERE due_date < hoje.d), 0)::float8 AS vencidas_valor,
       count(*) FILTER (WHERE due_date = hoje.d)::int AS hoje,
       COALESCE(sum(amount) FILTER (WHERE due_date = hoje.d), 0)::float8 AS hoje_valor,
       count(*) FILTER (WHERE due_date = hoje.d + 1)::int AS amanha,
       COALESCE(sum(amount) FILTER (WHERE due_date = hoje.d + 1), 0)::float8 AS amanha_valor,
       (array_agg(description ORDER BY amount DESC) FILTER (WHERE due_date = hoje.d))[1] AS primeira
     FROM bills, hoje WHERE account_id = $1 AND NOT paid
     GROUP BY hoje.d`,
    [accountId]
  );
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const lines = [];
  if (b?.vencidas) lines.push(`⚠️ ${b.vencidas} conta(s) vencida(s): ${brl(b.vencidas_valor)}`);
  if (b?.hoje) lines.push(`📅 Vence hoje: ${b.hoje === 1 && b.primeira ? b.primeira + ' — ' : b.hoje + ' conta(s) — '}${brl(b.hoje_valor)}`);
  if (b?.amanha) lines.push(`🗓️ Vence amanhã: ${b.amanha} conta(s) — ${brl(b.amanha_valor)}`);

  // Orçamentos estourados no mês atual
  const over = await q(
    `WITH m AS (SELECT date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date AS ini)
     SELECT b.category, b.amount::float8 AS lim, COALESCE(sum(t.amount), 0)::float8 AS gasto
     FROM budgets b CROSS JOIN m
     LEFT JOIN transactions t ON t.account_id = b.account_id AND t.type = 'saida'
       AND lower(COALESCE(t.category, '')) = lower(b.category)
       AND t.date >= m.ini AND t.date < (m.ini + interval '1 month')
     WHERE b.account_id = $1
     GROUP BY b.category, b.amount HAVING COALESCE(sum(t.amount), 0) > b.amount
     ORDER BY COALESCE(sum(t.amount), 0) / b.amount DESC LIMIT 2`,
    [accountId]
  );
  for (const o of over) lines.push(`💸 Orçamento de ${o.category} estourado: ${brl(o.gasto)} de ${brl(o.lim)}`);

  // Faturas de cartão vencendo hoje ou amanhã (que ainda não foram marcadas como pagas)
  const [{ hoje }] = await q(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS hoje`);
  const [Y, M, D] = hoje.split('-').map(Number);
  const amanha = new Date(Date.UTC(Y, M - 1, D + 1)).toISOString().slice(0, 10);
  const cards = await q(`SELECT id, name, closing_day, due_day FROM cards WHERE account_id = $1`, [accountId]);
  let fatura = false;
  for (const c of cards) {
    for (const [y, m] of [[Y, M], [Number(amanha.slice(0, 4)), Number(amanha.slice(5, 7))]]) {
      const r = invoiceRange(c, y, m);
      if (r.due !== hoje && r.due !== amanha) continue;
      const [pago] = await q(`SELECT 1 FROM card_paid WHERE card_id = $1 AND month = $2`, [c.id, `${y}-${pad(m)}`]);
      if (pago) continue;
      const [t] = await q(
        `SELECT COALESCE(sum(amount), 0)::float8 AS v FROM transactions
         WHERE account_id = $1 AND card_id = $2 AND type = 'saida' AND date > $3::date AND date <= $4::date`,
        [accountId, c.id, r.from, r.to]
      );
      if (t.v > 0) { lines.push(`💳 Fatura ${c.name} vence ${r.due === hoje ? 'hoje' : 'amanhã'}: ${brl(t.v)}`); fatura = true; }
      break;
    }
  }

  // Dia 1: resumo do mês que acabou
  let resumo = null;
  if (D === 1) {
    const ini = ymd(Y, M - 1, 1), fim = hoje;
    const [m] = await q(
      `SELECT COALESCE(sum(amount) FILTER (WHERE type = 'entrada'), 0)::float8 AS ent,
              COALESCE(sum(amount) FILTER (WHERE type = 'saida'), 0)::float8 AS sai
       FROM transactions WHERE account_id = $1 AND date >= $2::date AND date < $3::date`,
      [accountId, ini, fim]
    );
    if (m.ent || m.sai) {
      const [top] = await q(
        `SELECT COALESCE(NULLIF(category, ''), 'Sem categoria') AS cat, sum(amount)::float8 AS v
         FROM transactions WHERE account_id = $1 AND type = 'saida' AND date >= $2::date AND date < $3::date
         GROUP BY 1 ORDER BY 2 DESC LIMIT 1`,
        [accountId, ini, fim]
      );
      const res = m.ent - m.sai, nome = MESES[(M + 10) % 12];
      resumo = `Resumo de ${nome}`;
      lines.unshift(`📊 ${nome[0].toUpperCase() + nome.slice(1)} fechou: ${res >= 0 ? 'sobrou' : 'faltou'} ${brl(Math.abs(res))} (entrou ${brl(m.ent)}, saiu ${brl(m.sai)}).`
        + (top ? ` Maior gasto: ${top.cat}, ${brl(top.v)}.` : ''));
    }
  }

  const dl = acc.days_left;
  const plano = acc.plan === 'teste' ? 'Seu teste grátis' : 'Seu plano';
  if (acc.plan !== 'vitalicio' && dl != null && [7, 3, 1].includes(dl)) {
    lines.push(`⏳ ${plano} termina em ${dl} dia${dl > 1 ? 's' : ''}. Renove para não perder o acesso.`);
  }
  if (!lines.length) return null;
  return {
    title: b?.vencidas || b?.hoje ? 'Contas para pagar' : fatura ? 'Fatura do cartão' : resumo || 'Finanças do Casal',
    body: lines.join('\n'),
    url: b?.vencidas || b?.hoje || b?.amanha || fatura ? '/?tab=bills' : over.length ? '/?tab=budgets' : resumo ? '/?tab=painel' : '/?tab=conta',
  };
}

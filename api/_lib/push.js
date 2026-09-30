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

  const dl = acc.days_left;
  const plano = acc.plan === 'teste' ? 'Seu teste grátis' : 'Seu plano';
  if (acc.plan !== 'vitalicio' && dl != null && [7, 3, 1].includes(dl)) {
    lines.push(`⏳ ${plano} termina em ${dl} dia${dl > 1 ? 's' : ''}. Renove para não perder o acesso.`);
  }
  if (!lines.length) return null;
  return {
    title: b?.vencidas || b?.hoje ? 'Contas para pagar' : 'Finanças do Casal',
    body: lines.join('\n'),
    url: b?.vencidas || b?.hoje || b?.amanha ? '/?tab=bills' : '/?tab=conta',
  };
}

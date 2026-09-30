import { q } from './_lib/db.js';
import { baseUrl } from './_lib/billing.js';
import { sendPush, dailyDigest } from './_lib/push.js';

// Rodado 1x por dia pela Vercel (vercel.json → crons). Manda o resumo do dia
// para cada aparelho inscrito. Cada aparelho recebe no máximo 1 aviso por dia,
// então chamar esta rota de novo não gera avisos repetidos.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  try {
    const subs = await q(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth, u.account_id
       FROM push_subscriptions s
       JOIN users u ON u.id = s.user_id
       JOIN accounts a ON a.id = u.account_id
       WHERE a.paid_until IS NOT NULL AND a.paid_until > now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM push_log l WHERE l.sub_id = s.id
                         AND l.day = (now() AT TIME ZONE 'America/Sao_Paulo')::date)`
    );
    const digests = new Map();
    let sent = 0, skipped = 0, failed = 0;
    for (const s of subs) {
      if (!digests.has(s.account_id)) digests.set(s.account_id, await dailyDigest(s.account_id));
      const d = digests.get(s.account_id);
      if (!d) { skipped++; continue; }
      // Marca antes de enviar: se duas execuções cruzarem, só uma envia
      const mark = await q(
        `INSERT INTO push_log (sub_id, day) VALUES ($1, (now() AT TIME ZONE 'America/Sao_Paulo')::date)
         ON CONFLICT DO NOTHING RETURNING sub_id`,
        [s.id]
      );
      if (!mark.length) { skipped++; continue; }
      try { if (await sendPush(s, d, baseUrl(req))) sent++; } catch (e) { failed++; console.error('push', s.id, e.statusCode || e.message); }
    }
    await q(`DELETE FROM push_log WHERE day < (now() AT TIME ZONE 'America/Sao_Paulo')::date - 30`);
    res.json({ subs: subs.length, sent, skipped, failed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

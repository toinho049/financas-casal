import { q } from './_lib/db.js';
import { getSession } from './_lib/auth.js';
import { baseUrl } from './_lib/billing.js';
import { vapidKeys, sendPush, dailyDigest } from './_lib/push.js';

// Avisos no celular/computador (Web Push)
export default async function handler(req, res) {
  const action = req.query.action || '';
  try {
    if (req.method === 'GET' && action === 'key') {
      const { publicKey } = await vapidKeys();
      return res.json({ publicKey });
    }

    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
    const sub = req.body?.subscription || {};

    if (action === 'subscribe') {
      const endpoint = String(sub.endpoint || '');
      const { p256dh, auth } = sub.keys || {};
      if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return res.status(400).json({ error: 'Inscrição inválida' });
      await q(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [me.id, endpoint.slice(0, 1000), String(p256dh).slice(0, 200), String(auth).slice(0, 200)]
      );
      return res.json({ ok: true });
    }

    if (action === 'unsubscribe') {
      await q(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [String(sub.endpoint || req.body?.endpoint || ''), me.id]);
      return res.json({ ok: true });
    }

    // Manda um aviso de teste (ou o resumo do dia, se houver) para os aparelhos desta pessoa
    if (action === 'test') {
      const subs = await q(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [me.id]);
      if (!subs.length) return res.status(400).json({ error: 'Nenhum aparelho com avisos ativados' });
      const digest = await dailyDigest(me.account_id);
      const payload = digest || { title: 'Finanças do Casal', body: 'Avisos ativados! Você vai receber os lembretes das contas por aqui. ✅', url: '/' };
      let sent = 0;
      for (const s of subs) if (await sendPush(s, payload, baseUrl(req))) sent++;
      return res.json({ sent });
    }

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
